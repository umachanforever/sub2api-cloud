import test from 'node:test';
import assert from 'node:assert/strict';
import {effectiveAntigravityMapping,GEMINI_FALLBACK_IDS} from '../supabase/functions/sub2api/gemini_catalog.ts';
import {ANTIGRAVITY_MODELS} from '../supabase/functions/sub2api/antigravity_catalog.ts';
import {DEFAULT_PROVIDER_CATALOGS} from '../supabase/functions/sub2api/provider_models.ts';
import {antigravityOAuthRequest} from '../supabase/functions/sub2api/antigravity_oauth.ts';
import {mappedTarget} from '../supabase/functions/sub2api/model_mapping.ts';

test('Argon catalogs and default routing expose the upstream tier IDs',()=>{
 const mapping=effectiveAntigravityMapping({});
 assert.equal(mapping['gemini-4-argon'],'gemini-4-argon-high');
 for(const tier of ['low','medium','high']){
  const id='gemini-4-argon-'+tier;assert.equal(mapping[id],id);assert.ok(ANTIGRAVITY_MODELS.some(model=>model.id===id));
 }
 assert.ok(GEMINI_FALLBACK_IDS.includes('gemini-4-argon'));
 assert.ok(DEFAULT_PROVIDER_CATALOGS.gemini.some(model=>model.id==='gemini-4-argon'));
 assert.equal(effectiveAntigravityMapping({'gemini-4-argon':'custom'})['gemini-4-argon'],'custom');
});
test('Argon inference forwards the high default and explicit tiers without unsupported sampling fields',()=>{
 const request=new Request('https://edge/v1/messages'),signal=new AbortController().signal;
 const credentials={access_token:'private',project_id:'private-project'};
 for(const id of ['gemini-4-argon','gemini-4-argon-low','gemini-4-argon-medium','gemini-4-argon-high']){
  const model=mappedTarget(effectiveAntigravityMapping({}),id,'antigravity');assert.ok(model);
  const outgoing=antigravityOAuthRequest(credentials,'messages','/v1/messages',{model,stream:true,temperature:0.7,top_p:0.9,top_k:20,stop_sequences:['stop'],messages:[{role:'user',content:'Hi'}]},request,signal,id);
  const envelope=JSON.parse(outgoing.init.body);assert.equal(envelope.model,id==='gemini-4-argon'?'gemini-4-argon-high':id);
  for(const field of ['temperature','topP','topK','stopSequences'])assert.equal(envelope.request.generationConfig[field],undefined);
  assert.ok(envelope.request.toolConfig);assert.equal(outgoing.claudeModel,id);
 }
});
