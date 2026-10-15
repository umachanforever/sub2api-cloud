import test from 'node:test';
import assert from 'node:assert/strict';
import {usageEndpoint} from '../supabase/functions/sub2api/usage_endpoint.ts';
test('Usage endpoints retain protocol paths without URL credentials or query values',()=>{
 assert.equal(usageEndpoint('https://user:password@provider.invalid/v1/responses?key=private#private'),'/v1/responses');
 assert.equal(usageEndpoint('wss://provider.invalid/backend-api/codex/responses'),'/backend-api/codex/responses');
 assert.equal(usageEndpoint('https://provider.invalid/v1beta/models/gemini:generateContent?key=private'),'/v1beta/models/gemini:generateContent');
 assert.equal(usageEndpoint('not a URL'),null);
 assert.equal(usageEndpoint('https://provider.invalid/'+ 'a'.repeat(128)),null);
});
