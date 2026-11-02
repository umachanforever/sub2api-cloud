import test from 'node:test';
import assert from 'node:assert/strict';
import {createHandler} from './handler.mjs';

/** Synthetic image bytes exercise a large artifact without a provider call. */
const bytes = Buffer.concat([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAaX2RaAAAAAASUVORK5CYII=', 'base64'), Buffer.alloc(2 * 1024 * 1024)]);
/** WorkBuddy advertises a renderer, but generated art must still use the image model. */
const tools = [{type: 'function', function: {name: 'show_widget', parameters: {type: 'object', properties: {}}}}];

test('native WorkBuddy images deliver short signed links and preserve original bytes in JSON and SSE', async () => {
  for (const stream of [false, true]) for (const itemDone of [false, true]) for (const presentation of [false, true]) {
    const requestTools = presentation ? [...tools, {type: 'function', function: {name: 'present_files', parameters: {type: 'object', properties: {files: {type: 'array', items: {type: 'string'}}, explanation: {type: 'string'}}, required: ['files', 'explanation']}}}] : tools;
    let uploaded = 0, signed = 0, registered = 0, finished = 0;
    const handler = createHandler({url: 'https://project.supabase.co', serviceKey: 'synthetic-service', encryptionKey: '', adminIds: [], dataModel: 'native'}, async (url, init) => {
      url = String(url);
      if (url.endsWith('/s2a_personal_acquire')) return Response.json({lease_id: 'lease', allow_image_generation: true, account: {id: '1', type: 'oauth', platform: 'openai', credential_version: 1, credential_storage: 'vault', codex_settings: {auto_sync: 'false'}, credentials: {access_token: 'synthetic', chatgpt_account_id: 'account'}}});
      if (url.endsWith('/s2a_personal_finish')) {finished++; return Response.json(null);}
      if (url.endsWith('/s2a_chat_media_register')) {registered++; assert.equal(JSON.parse(init.body).p_lease_id, 'lease'); return Response.json(true);}
      if (url.includes('/storage/v1/object/sign/')) {
        signed++; assert.equal(JSON.parse(init.body).expiresIn, 604800);
        return Response.json({signedURL: new URL(url).pathname.replace('/storage/v1', '') + '?token=synthetic-signature'});
      }
      if (url.includes('/storage/v1/object/sub2api-artifacts/')) {
        uploaded++;
        assert.deepEqual(Buffer.from(init.body), bytes, 'must store original image bytes without compression');
        assert.equal(init.headers.get('content-type'), 'image/png');
        assert.match(url, /image-1\.png$/);
        return Response.json({});
      }
      assert.ok(url.includes('/responses'));
      const payload = JSON.parse(init.body);
      assert.ok(payload.tools.some(tool => tool.type === 'image_generation' && tool.model === 'gpt-image-2'));
      assert.match(payload.instructions, /Do not automatically call present_files/);
      assert.ok(payload.tools.some(tool => tool.type === 'function' && tool.name === 'show_widget'));
      const item = {type: 'image_generation_call', id: 'image-1', status: 'completed', result: bytes.toString('base64'), output_format: 'jpeg'};
      const events = [{type: 'response.created', response: {model: 'gpt-6-luna'}}, ...(itemDone ? [{type: 'response.output_item.done', output_index: 0, item}] : []), {type: 'response.completed', response: {status: 'completed', output: [item], usage: {input_tokens: 1, output_tokens: 2}}}];
      return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), {headers: {'content-type': 'text/event-stream'}});
    });
    const response = await handler(new Request('https://edge/v1/chat/completions', {method: 'POST', headers: {authorization: 'Bearer synthetic-client', 'content-type': 'application/json'}, body: JSON.stringify({model: 'gpt-6-luna', messages: [{role: 'user', content: 'Generate a bird image.'}], tools: requestTools, stream})}));
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.ok(body.length < 8000, 'image must not become megabytes of streamed prose');
    assert.ok(!body.includes('data:image/'));
    let content, calls;
    if (stream) {
      const frames = body.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6));
      assert.equal(frames.at(-1), '[DONE]');
      const values = frames.slice(0, -1).map(frame => JSON.parse(frame));
      assert.ok(!values.some(value => value.error));
      assert.equal(values.at(-1).choices[0].finish_reason, 'stop');
      calls = values.flatMap(value => value.choices?.[0]?.delta?.tool_calls ?? []);
      content = values.map(value => value.choices?.[0]?.delta?.content ?? '').join('');
    } else {const message = JSON.parse(body).choices[0].message; content = message.content; calls = message.tool_calls; }
    assert.equal(calls?.length ?? 0, 0, 'advertised file tools must not auto-open a preview');
    assert.match(content, /!\[Generated image\]\(https:\/\/project\.supabase\.co\/storage\/v1\/object\/sign\/sub2api-artifacts\/images\/imgtask_[a-f0-9]{32}\/image-1\.png\?token=synthetic-signature\)/);
    assert.equal(content.split('![Generated image]').length - 1, 1);
    assert.equal(uploaded, 1); assert.equal(signed, 1); assert.equal(registered, 1); assert.equal(finished, 1);
  }
});
