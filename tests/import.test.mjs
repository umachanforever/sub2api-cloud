import assert from "node:assert/strict";
import test from "node:test";
import {
  importCredentials,
  parseCredentials,
} from "../scripts/import-credentials.mjs";
import { decryptCredentials } from "../supabase/functions/subscription-api/credential_store.ts";

const credentials = {
  access_token: "access",
  refresh_token: "refresh",
  chatgpt_account_id: "account",
};
const key = Buffer.alloc(32, 7).toString("base64");
const groupId = "33333333-3333-4333-8333-333333333333";
const env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service",
  GPT_SUBSCRIPTION_CREDENTIALS_KEY_B64: key,
};

test("validates credential imports and discards unrelated account data", () => {
  assert.deepEqual(
    parseCredentials({ ...credentials, email: "private" }),
    credentials,
  );
  for (
    const invalid of [null, [], {}, { ...credentials, refresh_token: 123 }, {
      ...credentials,
      expires_at: "bad",
    }, { ...credentials, client_id: null }]
  ) {
    assert.throws(() => parseCredentials(invalid));
  }
  assert.equal(
    parseCredentials({ ...credentials, expires_at: 2_000_000_000 }).expires_at,
    2_000_000_000,
  );
});

test("imports only encrypted data and refuses to replace existing credentials", async () => {
  let privacyCalls=0;
  await importCredentials(
    credentials,
    groupId,
    "Imported",
    env,
    async (url, init) => {
      if(String(url).startsWith("https://chatgpt.com/")){privacyCalls++;return new Response(null,{status:204});}
      assert.equal(
        String(url),
        "https://example.supabase.co/rest/v1/s2a_accounts",
      );
      assert.equal(init.method, "POST");
      const row = JSON.parse(init.body);
      assert.equal(row.group_id, groupId);
      assert.equal(row.extra.privacy_mode,"training_off");
      assert.equal("access_token" in row, false);
      assert.deepEqual(await decryptCredentials(row, key), credentials);
      return new Response(null, { status: 201 });
    },
  );
  assert.equal(privacyCalls,1);
  await assert.rejects(
    importCredentials(
      credentials,
      groupId,
      "Imported",
      env,
      async () => new Response(null, { status: 409 }),
    ),
    /already exist/,
  );
  await assert.rejects(
    importCredentials(credentials, groupId, "Imported", {
      ...env,
      SUPABASE_URL: "http://example.com",
    }),
    /HTTPS/,
  );
  await assert.rejects(
    importCredentials(
      credentials,
      groupId,
      "Imported",
      env,
      async () => new Response(null, { status: 403 }),
    ),
    /403/,
  );
});

test("rejects ciphertext tampering and a different encryption key", async () => {
  const { encryptCredentials } = await import(
    "../supabase/functions/subscription-api/credential_store.ts"
  );
  const encrypted = await encryptCredentials(credentials, key);
  await assert.rejects(
    decryptCredentials(encrypted, Buffer.alloc(32, 8).toString("base64")),
  );
  const bytes = Buffer.from(encrypted.ciphertext, "base64");
  bytes[0] ^= 1;
  await assert.rejects(
    decryptCredentials(
      { ...encrypted, ciphertext: bytes.toString("base64") },
      key,
    ),
  );
});

test('imports safe model mappings separately and validates them before provider calls',async()=>{
 let writes=0;
 await importCredentials({...credentials,model_mapping:{alias:'gpt-4.1'}},groupId,'Mapped',env,async(url,init)=>{
  if(String(url).startsWith('https://chatgpt.com/'))return new Response(null,{status:204});
  const row=JSON.parse(init.body);assert.deepEqual(row.model_mapping,{alias:'gpt-4.1'});assert.deepEqual(await decryptCredentials(row,key),credentials);writes++;return new Response(null,{status:201});
 });
 assert.equal(writes,1);
 await assert.rejects(importCredentials({...credentials,model_mapping:{'bad*pattern':'gpt-4.1'}},groupId,'Invalid',env,async()=>{throw new Error('Must not contact provider');}),{code:'invalid_model_mapping'});
});

test('OAuth credentials reject control characters and oversized header values',()=>{
 for(const field of ['access_token','refresh_token','chatgpt_account_id']) {
  assert.throws(()=>parseCredentials({...credentials,[field]:'value\nheader'}),{code:`invalid_${field}`});
  assert.throws(()=>parseCredentials({...credentials,[field]:'x'.repeat(field==='chatgpt_account_id'?513:32769)}),{code:`invalid_${field}`});
 }
 for(const client_id of ['client\r\nheader','x'.repeat(513)])assert.throws(()=>parseCredentials({...credentials,client_id}),{code:'invalid_client_id'});
});
