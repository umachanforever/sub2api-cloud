import {jobSigningKey} from './job_signing.ts';
import { createHandler } from "./app.ts";
import { googleOAuthClients, googleOAuthVariables } from "./google_oauth_config.ts";

const url = Deno.env.get("SUPABASE_URL")?.trim();
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim();
const encryptionKey = Deno.env.get("GPT_SUBSCRIPTION_CREDENTIALS_KEY_B64")
  ?.trim();
if (!url || !serviceKey || !encryptionKey) {
  throw new Error("Missing Supabase or encryption configuration");
}
const dataModel = Deno.env.get("SUB2API_DATA_MODEL")?.trim();
if (dataModel && dataModel !== "native") throw new Error("SUB2API_DATA_MODEL must be native or unset");
const adminIds = (Deno.env.get("SUB2API_ADMIN_USER_IDS") ?? "").split(",").map((
  id,
) => id.trim().toLowerCase()).filter(Boolean);

const mailKey = Deno.env.get("RESEND_API_KEY")?.trim();
const mailFrom = Deno.env.get("SUB2API_MAIL_FROM")?.trim();
if (!!mailKey !== !!mailFrom || mailKey && !/^[A-Za-z0-9_-]{1,512}$/.test(mailKey) || mailFrom && (mailFrom.length > 254 || !/^[A-Za-z0-9.!_%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(mailFrom))) throw new Error("Configure RESEND_API_KEY and a valid SUB2API_MAIL_FROM together");
Deno.serve(
  createHandler({
    url: url.replace(/\/$/, ""),
    serviceKey,
    encryptionKey,
    jobSigningKey: await jobSigningKey(encryptionKey),
    adminIds,
    googleOAuth: googleOAuthClients(Object.fromEntries(googleOAuthVariables.map(key => [key, Deno.env.get(key)]))),
    ...(dataModel === "native" ? {dataModel} : {}),
    ...(mailKey && mailFrom ? { mail: { apiKey: mailKey, from: mailFrom } } : {}),
  }),
);
