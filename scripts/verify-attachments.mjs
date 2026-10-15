import { readFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';

function verificationPdf(code) {
  const stream = `BT /F1 16 Tf 50 750 Td (${code}) Tj ET`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
  let pdf = '%PDF-1.4\n'; const offsets = [];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const start = Buffer.byteLength(pdf);
  pdf += 'xref\n0 6\n0000000000 65535 f \n' + offsets.map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('') + `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(pdf).toString('base64');
}
function verificationImage() {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]); let crc = 0xffffffff;
    for (const byte of body) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    const size = Buffer.alloc(4), checksum = Buffer.alloc(4); size.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([size, body, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(128, 0); header.writeUInt32BE(64, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc((128 * 3 + 1) * 64);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 128; x++) pixels[y * 385 + 1 + x * 3 + (x < 64 ? 0 : 2)] = 255;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}
export async function verifyAttachments(config, fetcher = fetch, report = () => {}) {
  const base = new URL(config.base_url);
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || !base.pathname.replace(/\/+$/, '').endsWith('/v1')) throw Error('Configure an HTTP base_url ending in /v1 without credentials, query, or fragment');
  if (!config.api_key || !config.model) throw Error('Configure api_key and model');
  const api = base.href.replace(/\/+$/, ''), results = [];
  const code = 'ATTACHMENT-' + crypto.randomUUID().replaceAll('-', '').slice(0, 16).toUpperCase();
  const pdf = verificationPdf(code), image = verificationImage();
  for (const kind of ['pdf', 'image']) for (const protocol of ['responses', 'chat', 'messages']) {
    const prompt = kind === 'pdf' ? 'Read the attached PDF. Reply only with the code printed inside it.' : 'Name the color of the left half, then the right half, in English. Reply only with the two color names.';
    let content;
    if (protocol === 'responses') content = [{ type: 'input_text', text: prompt }, kind === 'pdf' ? { type: 'input_file', filename: 'verification.pdf', file_data: 'data:application/pdf;base64,' + pdf } : { type: 'input_image', image_url: 'data:image/png;base64,' + image }];
    else if (protocol === 'chat') content = [{ type: 'text', text: prompt }, kind === 'pdf' ? { type: 'file', file: { filename: 'verification.pdf', file_data: 'data:application/pdf;base64,' + pdf } } : { type: 'image_url', image_url: { url: 'data:image/png;base64,' + image } }];
    else content = [{ type: 'text', text: prompt }, { type: kind === 'pdf' ? 'document' : 'image', source: { type: 'base64', media_type: kind === 'pdf' ? 'application/pdf' : 'image/png', data: kind === 'pdf' ? pdf : image } }];
    const body = { model: config.model, stream: false, ...(protocol === 'responses' ? { input: [{ role: 'user', content }] } : { messages: [{ role: 'user', content }] }), ...(protocol === 'messages' ? { max_tokens: 128 } : {}) };
    const response = await fetcher(api + '/' + (protocol === 'chat' ? 'chat/completions' : protocol), { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(120000), headers: { authorization: 'Bearer ' + config.api_key, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!response.ok) { await response.body?.cancel(); throw Error(`${kind}/${protocol}: HTTP ${response.status}`); }
    const value = await response.json();
    const text = protocol === 'responses' ? value.output?.flatMap(item => item.content ?? []).filter(part => part.type === 'output_text').map(part => part.text).join('') : protocol === 'chat' ? value.choices?.[0]?.message?.content : value.content?.filter(part => part.type === 'text').map(part => part.text).join('');
    if (typeof text !== 'string' || !(kind === 'pdf' ? text.includes(code) : /\bred\b[\s\S]*\bblue\b/i.test(text))) throw Error(`${kind}/${protocol}: model did not read the attachment correctly`);
    const usage = value.usage;
    if (!usage || !Number.isSafeInteger(usage.input_tokens ?? usage.prompt_tokens) || (usage.input_tokens ?? usage.prompt_tokens) <= 0) throw Error(`${kind}/${protocol}: missing input usage`);
    results.push(`${kind}/${protocol}`); report(results.at(-1));
  }
  return results;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const config = JSON.parse(await readFile(new URL('../.local/agent-access.json', import.meta.url), 'utf8'));
    await verifyAttachments(config, fetch, result => console.log('Attachment verification passed: ' + result));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
