type Item = Record<string, any>;
export const IMAGE_CHAT_FRAME_LIMIT = 32 * 1024 * 1024;

export function enableChatImages(body: Item): void {
  if (!(body.tools ?? []).some((tool: Item) => tool.type === 'image_generation')) {
    body.tools = [...(body.tools ?? []), {type: 'image_generation', model: 'gpt-image-2'}];
  }
  body.instructions = [body.instructions,
    'When the user asks you to create or edit an image, use the image_generation tool. For ordinary text questions, answer normally. Never claim an image was generated unless the tool returned one.',
  ].filter(Boolean).join('\n\n');
  // Clients send rendered image Markdown back in assistant history. Restore it as
  // visual input instead of making the model tokenize megabytes of base64 text.
  if (Array.isArray(body.input)) body.input = body.input.flatMap((item: Item) => {
    if (item.role !== 'assistant' || !Array.isArray(item.content)) return [item];
    const images: Item[] = [];
    const content = item.content.map((part: Item) => {
      if (part.type !== 'output_text' || typeof part.text !== 'string') return part;
      const text = part.text.replace(/!\[Generated image\]\((data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2})\)/g, (_match: string, url: string) => {
        images.push({type: 'input_image', image_url: url});
        return '[Previously generated image]';
      });
      return {...part, text};
    });
    return images.length ? [{...item, content}, {type: 'message', role: 'user', content: [{type: 'input_text', text: 'Previously generated image, provided for visual reference:'}, ...images]}] : [item];
  });
}

// Inline image data keeps chat history self-contained without public uploads or expiring URLs.
export function chatImageMarkdown(item: Item): string {
  if (item.type !== 'image_generation_call' || typeof item.result !== 'string' || !item.result) return '';
  if (item.result.length > IMAGE_CHAT_FRAME_LIMIT || !/^[A-Za-z0-9+/]+={0,2}$/.test(item.result)) throw new Error('Invalid generated image');
  const format = item.output_format;
  const mime = format === 'jpeg' || format === 'jpg' ? 'image/jpeg' : format === 'webp' ? 'image/webp' : 'image/png';
  return `\n\n![Generated image](data:${mime};base64,${item.result})\n\n`;
}
