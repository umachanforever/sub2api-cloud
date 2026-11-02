type Body = Record<string, unknown>;

// These verified text models reject image-output options sent by some chat clients.
// Use the mapped upstream model: an alias may actually target an image model.
export function normalizeGeminiTextOutput(model: string, body: Body): void {
  if (!['gemini-3-flash', 'gemini-3-flash-preview'].includes(model.trim().toLowerCase().replace(/^models\//, ''))) return;
  for (const key of ['generationConfig', 'generation_config']) {
    const value = body[key];
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const config = { ...value } as Body;
    for (const field of ['responseModalities', 'response_modalities']) {
      const modalities = config[field];
      if (Array.isArray(modalities)) {
        config[field] = [...new Set(modalities.map(modality =>
          modality === 2 || typeof modality === 'string' && modality.trim().toUpperCase() === 'IMAGE' ? 'TEXT' : modality
        ))];
      }
    }
    delete config.imageConfig;
    delete config.image_config;
    body[key] = config;
  }
}
