type Item = Record<string, any>;
/** Bound upstream SSE frames independently from decoded image bytes. */
export const IMAGE_CHAT_FRAME_LIMIT = 32 * 1024 * 1024;
/** Match the inline image limit used by codex-agent-bridge. */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export function enableChatImages(body: Item): boolean {
  const format = body.text?.format?.type ?? body.response_format?.type;
  if (format === 'json_object' || format === 'json_schema') return false;
  if (!(body.tools ?? []).some((tool: Item) => tool.type === 'image_generation')) {
    body.tools = [...(body.tools ?? []), {type: 'image_generation', model: 'gpt-image-2'}];
  }
  body.instructions = [body.instructions,
    'When the user asks you to create or edit an image, use the image_generation tool. For ordinary text questions, answer normally. Never claim an image was generated unless the tool returned one.',
  ].filter(Boolean).join('\n\n');
  // Restore both string and multipart assistant history as visual input, not tokens.
  if (Array.isArray(body.input)) body.input = body.input.flatMap((item: Item) => {
    if (item.role !== 'assistant') return [item];
    const parts = typeof item.content === 'string' ? [{type: 'output_text', text: item.content}] : item.content;
    if (!Array.isArray(parts)) return [item];
    const images: Item[] = [];
    const content = parts.map((part: Item) => {
      if (part.type !== 'output_text' || typeof part.text !== 'string') return part;
      const text = part.text.replace(/!\[Generated image\]\((data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}|https:\/\/[^\s()]+\/storage\/v1\/object\/sign\/sub2api-artifacts\/images\/imgtask_[a-f0-9]{32}\/image-1\.(?:png|jpg|webp)\?token=[^\s()]+)\)/g, (_match: string, url: string) => {
        images.push({type: 'input_image', image_url: url});
        return '[Previously generated image]';
      });
      return {...part, text};
    });
    return images.length ? [{...item, content}, {type: 'message', role: 'user', content: [{type: 'input_text', text: 'Previously generated image, provided for visual reference:'}, ...images]}] : [item];
  });
  return true;
}

/** Render inline bytes like codex-agent-bridge; retain legacy signed-link support. */
export function chatImageMarkdown(item: Item): string {
  if (item.type !== 'image_generation_call') return '';
  if (item.error || item.failure || item.status && item.status !== 'completed') throw new Error('image_generation_failed');
  if (typeof item.result === 'string' && item.result) {
    const result = item.result;
    if (result.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(result)) throw new Error('Invalid generated image');
    const bytes = atob(result);
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES || btoa(bytes) !== result) throw new Error('Invalid generated image');
    // Sniff actual bytes: upstream output_format can be absent or inaccurate.
    const mime = bytes.startsWith('\x89PNG\r\n\x1a\n') ? 'image/png'
      : bytes.startsWith('\xff\xd8\xff') ? 'image/jpeg'
      : bytes.startsWith('RIFF') && bytes.slice(8, 12) === 'WEBP' ? 'image/webp'
      : ['GIF87a', 'GIF89a'].includes(bytes.slice(0, 6)) ? 'image/gif' : undefined;
    if (!mime) throw new Error('Invalid generated image');
    return `\n\n![Generated image](data:${mime};base64,${result})\n\n`;
  }
  if (typeof item.chat_image_url === 'string') {
    const url = new URL(item.chat_image_url);
    if (url.protocol !== 'https:' || url.username || url.password || !/^\/storage\/v1\/object\/sign\/sub2api-artifacts\/images\/imgtask_[a-f0-9]{32}\/image-1\.(png|jpg|webp)$/.test(url.pathname)) throw new Error('Invalid generated image URL');
    return `\n\n![Generated image](${url.href})\n\n`;
  }
  throw new Error('image_generation_failed');
}
