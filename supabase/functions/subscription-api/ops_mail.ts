import { savedSMTP, type SMTPTransport } from "./smtp.ts";
import { smtpTransport } from "./smtp_transport.mjs";
import { Database, HttpError } from "./db.ts";
import { json } from "./http.ts";
import { authorizeJob } from "./privacy_jobs.ts";

export type MailDelivery = { id: string; lease_id: string; recipient: string; payload: Record<string, unknown>[] };
export async function runMailJobs(db: Database, send: (delivery: MailDelivery) => Promise<void>, transport: "http" | "smtp" = "http") {
  const jobs = await db.rpc<MailDelivery[]>("s2a_ops_mail_claim", { p_transport: transport });
  let delivered = 0;
  await Promise.all(jobs.map(async job => {
    let error: string | null = null;
    try { await send(job); } catch (failure) { error = failure && typeof failure === "object" && "code" in failure && failure.code === "smtp_delivery_uncertain" ? "smtp_delivery_uncertain" : "delivery_failed"; }
    try { if (await db.rpc<boolean>("s2a_ops_mail_finish", { p_id: job.id, p_lease: job.lease_id, p_error: error }) && error === null) delivered++; }
    catch { console.warn("mail_delivery_finish_failed"); }
  }));
  return { claimed: jobs.length, delivered };
}
export async function mailJobs(request: Request, db: Database, transport: SMTPTransport = smtpTransport) {
  await authorizeJob(request, db, "mail");
  const mail = db.config.mail, smtp = await savedSMTP(db);
  if (!mail && (!smtp.smtp_host || !smtp.smtp_from_email)) return json(200, { enabled: false, claimed: 0, delivered: 0 });
  return json(200, { enabled: true, ...await runMailJobs(db, async job => {
    if (smtp.smtp_host && smtp.smtp_from_email) {
      await transport(smtp, { id: job.id, to: job.recipient, subject: `[Ops] ${job.payload.length} notifications`, text: job.payload.map(item => JSON.stringify(item, null, 2)).join("\n\n") });
      return;
    }
    const response = await db.fetchImpl("https://api.resend.com/emails", { method: "POST", headers: { authorization: `Bearer ${mail!.apiKey}`, "content-type": "application/json", "idempotency-key": job.id },
      body: JSON.stringify({ from: mail!.from, to: [job.recipient], subject: `[Ops] ${job.payload.length} notification${job.payload.length === 1 ? "" : "s"}`, text: job.payload.map(item => JSON.stringify(item, null, 2)).join("\n\n") }), signal: AbortSignal.timeout(15000) });
    if (!response.ok) { await response.body?.cancel(); throw new Error("delivery_failed"); }
    const receipt = await response.json();
    if (typeof receipt.id !== "string" || !receipt.id) throw new Error("invalid_delivery_receipt");
    // Expire uncertain deliveries before the provider's 24-hour idempotency window ends.
  }, smtp.smtp_host && smtp.smtp_from_email ? "smtp" : "http") });
}
