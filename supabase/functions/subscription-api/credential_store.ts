import type {
  AccountCredentials,
  ApiKeyCredentials,
  OAuthCredentials,
} from "./gateway.ts";

export type EncryptedCredentials = { ciphertext: string; iv: string };
export type VaultCredentials = {
  credential_storage: "vault";
  credentials: Record<string, unknown>;
};
export type StoredCredentials = EncryptedCredentials | VaultCredentials;
export const isVaultCredentials = (
  value: StoredCredentials,
): value is VaultCredentials =>
  "credential_storage" in value && value.credential_storage === "vault";

const bytesToBase64 = (value: Uint8Array) => {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const base64ToBytes = (value: string) =>
  Uint8Array.from(atob(value), (character) => character.charCodeAt(0));

async function importEncryptionKey(encoded: string) {
  const bytes = base64ToBytes(encoded);
  if (bytes.byteLength !== 32) {
    throw new Error("GPT_SUBSCRIPTION_CREDENTIALS_KEY_B64 必须是 32 字节密钥");
  }
  return await crypto.subtle.importKey("raw", bytes, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptCredentials(
  credentials: AccountCredentials | Record<string, unknown>,
  encodedKey: string,
): Promise<EncryptedCredentials> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await importEncryptionKey(encodedKey);
  const plaintext = new TextEncoder().encode(JSON.stringify(credentials));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    plaintext,
  );
  return {
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    iv: bytesToBase64(iv),
  };
}

export async function decryptCredentials(
  encrypted: StoredCredentials,
  encodedKey: string,
): Promise<OAuthCredentials> {
  const value = (await decryptSecret(
    encrypted,
    encodedKey,
  )) as OAuthCredentials;
  if (
    typeof value.access_token !== "string" ||
    !value.access_token.trim() ||
    typeof value.refresh_token !== "string" ||
    !value.refresh_token.trim()
  ) {
    throw new Error("云端 OAuth 凭据不完整");
  }
  return value;
}

export async function decryptApiKeyCredentials(
  encrypted: StoredCredentials,
  encodedKey: string,
): Promise<ApiKeyCredentials> {
  const value = (await decryptSecret(
    encrypted,
    encodedKey,
  )) as ApiKeyCredentials;
  if (typeof value.api_key !== "string" || !value.api_key.trim()) {
    throw new Error("Invalid encrypted API key credentials");
  }
  return value;
}

export async function decryptSecret(
  encrypted: StoredCredentials,
  encodedKey: string,
): Promise<Record<string, unknown>> {
  if (isVaultCredentials(encrypted)) {
    if (
      !encrypted.credentials ||
      typeof encrypted.credentials !== "object" ||
      Array.isArray(encrypted.credentials)
    )
      throw new Error("Invalid Vault credential document");
    return structuredClone(encrypted.credentials);
  }
  const key = await importEncryptionKey(encodedKey);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(encrypted.iv) },
    key,
    base64ToBytes(encrypted.ciphertext),
  );
  const value = JSON.parse(new TextDecoder().decode(plaintext)) as Record<
    string,
    unknown
  >;
  return value;
}
