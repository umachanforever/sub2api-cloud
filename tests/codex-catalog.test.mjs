import test from 'node:test';
import assert from 'node:assert/strict';
import {codexCatalogDescriptor} from '../supabase/functions/sub2api/codex_catalog.ts';
test('original Codex templates retain Sol reasoning choices and full model instructions',()=>{
 const value=codexCatalogDescriptor('gpt-6.1-sol');assert.equal(value.slug,'gpt-6.1-sol');assert.ok(value.model_messages.instructions_template.length>1000);assert.equal(value.model_messages.instructions_template_ref,undefined);
 const choices=value.supported_reasoning_levels.map(level=>level.effort);assert.ok(choices.includes('max'));assert.ok(!choices.includes('none'));assert.ok(!choices.includes('minimal'));assert.ok(value.context_window>100000);
});
test('original media-only descriptors are omitted and unknown custom models retain conservative metadata',()=>{
 for(const name of ['gpt-image-1','gpt-image-99','openai/gpt-image-99','grok-imagine-video','xai/grok-imagine-video-9','gemini-3.1-flash-image','models/gemini-3.1-flash-image-new'])assert.equal(codexCatalogDescriptor(name),undefined);
 const value=codexCatalogDescriptor('my-provider/custom');assert.equal(value.slug,'my-provider/custom');assert.deepEqual(value.input_modalities,['text']);assert.deepEqual(value.supported_reasoning_levels.map(level=>level.effort),['none']);assert.match(value.description,/sub2api-cloud/);assert.ok(!value.model_messages.instructions_template.includes('You are GPT-'));
});
test('restoring and editing a descriptor cannot mutate shared instructions or later aliases',()=>{
 const first=codexCatalogDescriptor('gpt-6.1-sol');first.model_messages.instructions_template='changed';first.supported_reasoning_levels.length=0;
 const second=codexCatalogDescriptor('gpt-6.1-sol');assert.notEqual(second.model_messages.instructions_template,'changed');assert.ok(second.supported_reasoning_levels.length>0);
 assert.equal(codexCatalogDescriptor('another-model').slug,'another-model');assert.equal(codexCatalogDescriptor('custom-model').slug,'custom-model');
});
