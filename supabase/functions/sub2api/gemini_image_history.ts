type Item = Record<string, any>;

// Our inline image replies can return as Markdown when clients switch models.
// Restore the original bytes as visual input instead of millions of text tokens.
export function normalizeGeminiImageHistory(body: Item): void {
  if (!Array.isArray(body.contents)) return;
  body.contents = body.contents.map((content: Item) => {
    if (content?.role !== 'model' || !Array.isArray(content.parts)) return content;
    let changed = false;
    const parts = content.parts.flatMap((part: Item) => {
      if (!part || part.thought || typeof part.text !== 'string') return [part];
      const images: Item[] = [];
      const text = part.text.replace(/!\[Generated image\]\(data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})\)/g,
        (match: string, mimeType: string, data: string) => {
          // Match the existing 20 MiB inline image bound; never fetch remote URLs.
          const bytes = data.length / 4 * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
          if (data.length % 4 || bytes <= 0 || bytes > 20 * 1024 * 1024) return match;
          images.push({ inlineData: { mimeType, data } });
          return '[Previously generated image]';
        });
      if (!images.length) return [part];
      changed = true;
      return [{ ...part, text }, ...images];
    });
    return changed ? { ...content, parts } : content;
  });
}
