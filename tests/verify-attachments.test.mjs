import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { verifyAttachments } from '../scripts/verify-attachments.mjs';
const config = { base_url: 'https://gateway.invalid/v1', api_key: 'sk-private', model: 'vision-model' };
test('Attachment acceptance sends real PDF/PNG data through all three protocols', async () => {
  let calls = 0;
  const results = await verifyAttachments(config, async (url, init) => {
    calls++;
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer sk-private');
    assert.equal(init.redirect, 'error');
    const body = JSON.parse(init.body), content = (body.input ?? body.messages)[0].content;
    const part = content[1]; let text;
    const encoded = part.file_data ?? part.file?.file_data ?? part.image_url?.url ?? part.image_url ?? part.source?.data;
    const data = Buffer.from(encoded.includes(',') ? encoded.split(',')[1] : encoded, 'base64');
    if (data.subarray(0, 4).toString() === '%PDF') {
      text = data.toString().match(/ATTACHMENT-[A-F0-9]{16}/)[0];
      assert.equal(JSON.stringify(content[0]).includes(text), false);
    } else {
      assert.equal(data.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      let offset = 8, compressed;
      while (offset < data.length) { const size = data.readUInt32BE(offset); if (data.subarray(offset + 4, offset + 8).toString() === 'IDAT') compressed = data.subarray(offset + 8, offset + 8 + size); offset += size + 12; }
      const pixels = inflateSync(compressed);
      assert.deepEqual([...pixels.subarray(1, 4)], [255, 0, 0]);
      assert.deepEqual([...pixels.subarray(193, 196)], [0, 0, 255]);
      text = 'red, blue';
    }
    const usage = { input_tokens: 40, output_tokens: 8 };
    if (url.endsWith('/responses')) return Response.json({ output: [{ content: [{ type: 'output_text', text }] }], usage });
    if (url.endsWith('/messages')) return Response.json({ content: [{ type: 'text', text }], usage });
    return Response.json({ choices: [{ message: { content: text } }], usage: { prompt_tokens: 40, completion_tokens: 8 } });
  });
  assert.equal(calls, 6); assert.equal(results.length, 6);
});
test('Attachment acceptance rejects invented answers and upstream errors', async () => {
  await assert.rejects(verifyAttachments(config, async () => Response.json({ output: [{ content: [{ type: 'output_text', text: 'I read the file' }] }], usage: { input_tokens: 5 } })), /did not read/);
  await assert.rejects(verifyAttachments(config, async () => new Response('private upstream detail', { status: 502 })), /^Error: pdf\/responses: HTTP 502$/);
  await assert.rejects(verifyAttachments({ ...config, base_url: 'https://user:secret@gateway.invalid/v1' }), /Configure an HTTP base_url/);
});
