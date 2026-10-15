import { isIP } from "node:net";
import { Database, HttpError } from "./db.ts";
import { decryptSecret } from "./credential_store.ts";
import { boolean, integer } from "./validation.ts";

export const smtpDefaults = { smtp_host: "", smtp_port: 587, smtp_username: "", smtp_from_email: "", smtp_from_name: "", smtp_use_tls: true, smtp_password_configured: false };
export type SMTPConfig = typeof smtpDefaults & { smtp_password: string };
export type SMTPMessage = { id: string; to: string; subject: string; text: string };
export type SMTPTransport = (config: SMTPConfig, message?: SMTPMessage) => Promise<void>;
export function smtpField(key: string, value: unknown): unknown {
  if (key === "smtp_port") return integer(value, 1, 65535);
  if (key === "smtp_use_tls" || key === "smtp_password_configured") return boolean(value);
  if (typeof value !== "string" || value.length > (key === "smtp_password" ? 4096 : key === "smtp_username" ? 512 : 254) || key !== "smtp_password" && /[\x00-\x1f\x7f]/.test(value)) throw new HttpError(400, "invalid_smtp_config");
  const text = key === "smtp_password" ? value : value.trim();
  if (key === "smtp_host" && text && (text.length > 253 || (text.includes(":") ? isIP(text) !== 6 : text.replace(/\.$/, "").split(".").some(part => !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(part))))) throw new HttpError(400, "invalid_smtp_host");
  if (key === "smtp_from_email" && text && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(text)) throw new HttpError(400, "invalid_smtp_sender");
  return key === "smtp_host" ? text.toLowerCase() : text;
}
export async function savedSMTP(db: Database): Promise<SMTPConfig> {
  const row = await db.rpc<Record<string, unknown>>("s2a_smtp_worker_config", {});
  const config = { ...smtpDefaults, ...Object.fromEntries(Object.keys(smtpDefaults).filter(key => key in row).map(key => [key, row[key]])), smtp_password: "" } as SMTPConfig;
  for (const key of Object.keys(smtpDefaults)) smtpField(key, config[key as keyof SMTPConfig]);
  if (typeof row.ciphertext === "string" && typeof row.iv === "string") {
    try {
      const secret = await decryptSecret({ ciphertext: row.ciphertext, iv: row.iv }, db.config.encryptionKey);
      config.smtp_password = smtpField("smtp_password", secret.password) as string;
    } catch { throw new HttpError(503, "smtp_credentials_unavailable"); }
  }
  return config;
}
