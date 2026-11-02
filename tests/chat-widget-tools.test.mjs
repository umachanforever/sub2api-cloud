import test from 'node:test';
import assert from 'node:assert/strict';
import {enableChatImages} from '../supabase/functions/sub2api/chat_images.ts';
import {createHandler} from './handler.mjs';

/** Synthetic WorkBuddy declarations; the client owns both implementations. */
const tools = ['widget_guidelines', 'show_widget'].map(name => ({
  type: 'function', function: {name, description: `Client ${name} tool`, parameters: {type: 'object', properties: {}}},
}));

test('widget clients retain their tools but use native generation for actual image requests', () => {
  const body = {tools: tools.map(tool => ({type: 'function', ...tool.function})), instructions: 'Use client tools.', tool_choice: 'auto'};
  const original = structuredClone(body.tools);
  assert.equal(enableChatImages(body), true);
  assert.deepEqual(body.tools.filter(tool => tool.type === 'function'), original);
  assert.ok(body.tools.some(tool => tool.type === 'image_generation' && tool.model === 'gpt-image-2'));
  assert.match(body.instructions, /image_generation/);
  assert.match(body.instructions, /Do not substitute.*show_widget/);
  assert.equal(body.tool_choice, 'auto');
  const ordinary = {tools: [{type: 'function', name: 'lookup'}]};
  assert.equal(enableChatImages(ordinary), true);
  assert.ok(ordinary.tools.some(tool => tool.type === 'image_generation'));
});

test('widget clients preserve explicit native image tools and structured JSON restrictions', () => {
  const body = {tools: [{type: 'function', name: 'show_widget'}, {type: 'image_generation', model: 'gpt-image-2'}]};
  assert.equal(enableChatImages(body), true);
  assert.equal(body.tools.filter(tool => tool.type === 'image_generation').length, 1);
  const json = {tools: [{type: 'function', name: 'show_widget'}], text: {format: {type: 'json_schema'}}};
  const original = structuredClone(json);
  assert.equal(enableChatImages(json), false);
  assert.deepEqual(json, original);
});

test('OAuth chat relays widget guidelines and rendering calls through JSON and SSE across tool results', async () => {
  for (const stream of [false, true]) {
    const messages = [{role: 'system', content: 'Draw using the client widget tools.'}, {role: 'user', content: 'Draw a bird.'}];
    for (const [index, name] of ['widget_guidelines', 'show_widget'].entries()) {
      let dispatched = false;
      const args = index === 0 ? '{"widget_type":"svg"}' : '{"code":"<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>"}';
      const callId = `call-widget-${index}`;
      const handler = createHandler({url: 'https://db.invalid', serviceKey: 'service', encryptionKey: '', adminIds: [], dataModel: 'native'}, async (url, init) => {
        if (String(url).endsWith('/s2a_personal_acquire')) return Response.json({lease_id: 'lease', allow_image_generation: true, account: {id: '1', type: 'oauth', platform: 'openai', credential_version: 1, credential_storage: 'vault', codex_settings: {auto_sync: 'false'}, credentials: {access_token: 'synthetic', chatgpt_account_id: 'account'}}});
        if (String(url).endsWith('/s2a_personal_finish')) return Response.json(null);
        assert.ok(String(url).includes('/responses'));
        const payload = JSON.parse(init.body);
        dispatched = true;
        assert.equal(payload.tools.some(tool => tool.type === 'image_generation'), true);
        assert.deepEqual(payload.tools.filter(tool => tool.type === 'function'), tools.map(tool => ({...tool.function, type: 'function'})));
        assert.ok(payload.instructions.includes('use the image_generation tool'));
        assert.equal(payload.tool_choice, 'auto');
        if (index) assert.ok(payload.input.some(item => item.type === 'function_call_output' && item.call_id === 'call-widget-0' && item.output === 'Use an SVG widget.'));
        const item = {type: 'function_call', call_id: callId, name, arguments: args};
        const events = [
          {type: 'response.created', response: {model: 'gpt-6-luna'}},
          {type: 'response.output_item.added', output_index: 0, item: {...item, arguments: ''}},
          {type: 'response.function_call_arguments.delta', output_index: 0, delta: args},
          {type: 'response.completed', response: {status: 'completed', output: [item], usage: {input_tokens: 1, output_tokens: 2}}},
        ];
        return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), {headers: {'content-type': 'text/event-stream'}});
      });
      const response = await handler(new Request('https://edge/v1/chat/completions', {method: 'POST', headers: {authorization: 'Bearer synthetic-client', 'content-type': 'application/json'}, body: JSON.stringify({model: 'gpt-6-luna', messages, tools, tool_choice: 'auto', stream})}));
      assert.equal(response.status, 200);
      assert.ok(dispatched);
      if (stream) {
        const frames = (await response.text()).split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6));
        assert.equal(frames.at(-1), '[DONE]');
        const values = frames.slice(0, -1).map(frame => JSON.parse(frame));
        assert.ok(!values.some(value => value.error));
        const calls = values.flatMap(value => value.choices?.[0]?.delta?.tool_calls ?? []);
        assert.equal(calls[0].id, callId);
        assert.equal(calls[0].function.name, name);
        assert.equal(calls.map(call => call.function.arguments ?? '').join(''), args);
        assert.equal(values.at(-1).choices[0].finish_reason, 'tool_calls');
      } else {
        const choice = (await response.json()).choices[0];
        assert.equal(choice.finish_reason, 'tool_calls');
        assert.deepEqual(choice.message.tool_calls, [{id: callId, type: 'function', function: {name, arguments: args}}]);
      }
      messages.push({role: 'assistant', content: null, tool_calls: [{id: callId, type: 'function', function: {name, arguments: args}}]}, {role: 'tool', tool_call_id: callId, content: 'Use an SVG widget.'});
    }
  }
});
