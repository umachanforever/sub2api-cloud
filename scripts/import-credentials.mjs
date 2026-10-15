import { resolveProjectCredentials } from "./project-credentials.mjs";
import {modelMapping} from "../supabase/functions/subscription-api/model_mapping.ts";
import { disableOpenAITraining } from "../supabase/functions/subscription-api/openai_privacy.ts";
import { readFile } from "node:fs/promises";
import { encryptCredentials } from "../supabase/functions/subscription-api/credential_store.ts";
import {
  hashKey,
  label,
  parseCredentials,
  uuid,
} from "../supabase/functions/subscription-api/validation.ts";
export { parseCredentials };

export async function importCredentials(
  source,
  groupId,
  name,
  env = process.env,
  fetchImpl = fetch,
) {
  env = await resolveProjectCredentials(env, fetchImpl);
  const url = new URL(env.SUPABASE_URL);
  if (url.protocol !== "https:") throw new Error("SUPABASE_URL must use HTTPS");
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  const encryptionKey = env.GPT_SUBSCRIPTION_CREDENTIALS_KEY_B64?.trim();
  if (!serviceKey || !encryptionKey) {
    throw new Error("Missing service role or encryption key");
  }
  const group_id = uuid(groupId), accountName = label(name);
  const mapping = source?.model_mapping === undefined ? {} : modelMapping(source.model_mapping);
  const credentials = parseCredentials(source);
  const encrypted = await encryptCredentials(credentials, encryptionKey);
  const privacy_mode = await disableOpenAITraining(credentials.access_token,fetchImpl);
  // Insert only; a unique account fingerprint prevents duplicate rotation owners.
  const response = await fetchImpl(new URL("/rest/v1/s2a_accounts", url), {
    method: "POST",
    headers: {
      apikey: serviceKey,
      authorization: `Bearer ${serviceKey}`,
      "content-type": "application/json",
      prefer: "return=minimal",
    },
    body: JSON.stringify({
      group_id,
      name: accountName,
      extra: {privacy_mode},
      model_mapping: mapping,
      account_fingerprint: await hashKey(credentials.chatgpt_account_id),
      ...encrypted,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 409) {
    throw new Error("Account already exists; import refused");
  }
  if (!response.ok) {
    throw new Error(`Credential import failed (${response.status})`);
  }
}

if (import.meta.main) {
  try {
    if (!process.argv[2] || !process.argv[3] || !process.argv[4]) {
      throw new Error(
        "Usage: npm run credentials:import -- GROUP_UUID /path/to/account.credentials.json NAME",
      );
    }
    await importCredentials(
      JSON.parse(await readFile(process.argv[3], "utf8")),
      process.argv[2],
      process.argv[4],
    );
    console.log("Encrypted account imported.");
  } catch (error) {
    // Never print remote bodies or JSON parse errors that may contain credentials.
    console.error(
      error instanceof SyntaxError ? "Invalid credentials JSON" : error.message,
    );
    process.exitCode = 1;
  }
}
