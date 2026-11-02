type Item = Record<string, any>;
/** Bound upstream SSE frames independently from decoded image bytes. */
export const IMAGE_CHAT_FRAME_LIMIT = 32 * 1024 * 1024;
/** Match the inline image limit used by codex-agent-bridge. */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** Detect client renderers that should load original image files instead of large text deltas. */
export function usesChatImageFiles(body: Item): boolean {
  return (body.tools ?? []).some((tool: Item) => tool.type === 'function' &&
    ['show_widget', 'present_files'].includes(tool.name ?? tool.function?.name));
}

export function enableChatImages(body: Item): boolean {
  const format = body.text?.format?.type ?? body.response_format?.type;
  if (format === 'json_object' || format === 'json_schema') return false;
  if (!(body.tools ?? []).some((tool: Item) => tool.type === 'image_generation')) {
    body.tools = [...(body.tools ?? []), {type: 'image_generation', model: 'gpt-image-2'}];
  }
  body.instructions = [body.instructions,
    'When the user asks you to create or edit an image, use the image_generation tool. For ordinary text questions, answer normally. Never claim an image was generated unless the tool returned one.',
    usesChatImageFiles(body) ? 'Generated images must stay inline in the chat by default. Let gateway file delivery finish to create native image cards. Do not automatically call present_files, show_widget, preview_url, open_result_view, or open a browser/side panel for generated images. Only when the user explicitly requests an additional download, save, copy, or export, use available file tools on the original image and present the local file if needed. Never redraw, compress, or regenerate it for export. Do not print the source URL in chat.' : '',
    usesChatImageFiles(body) ? 'For image generation requests, use the provider-hosted image generation tool (exposed to the model as image_gen.imagegen) to produce the actual image. The gateway API tool type is image_generation; that is not necessarily its model-facing callable name. Do not discover or call the separate client ImageGen tool, including via ToolSearch or DeferExecuteTool, for these requests. Do not substitute SVG, HTML, canvas or show_widget drawings for generated images. The gateway delivers the original image for direct display by the client.' : '',
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
    return images.length ? [{...item, content}, {type: 'message', role: 'user', content: [{type: 'input_text', text: 'Previously generated image, provided for visual reference:'}, ...images, ...images.filter((image: Item) => image.image_url.startsWith('https:')).map((image: Item) => ({type: 'input_text', text: 'Original image source for user-requested file export only (do not open or print automatically): ' + image.image_url}))]}] : [item];
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
