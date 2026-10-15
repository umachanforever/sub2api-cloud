// Model picker metadata from the pinned Sub2API provider catalogs.
export const DEFAULT_PROVIDER_CATALOGS:Record<string,Record<string,unknown>[]> = {
  "openai": [
    {"id":"gpt-5.6-sol","object":"model","created":1780876800,"owned_by":"openai","type":"model","display_name":"GPT-5.6 Sol"},
    {"id":"gpt-6","object":"model","created":1788480000,"owned_by":"openai","type":"model","display_name":"GPT-6 (Astra)"},
    {"id":"gpt-5.6","object":"model","created":1780876800,"owned_by":"openai","type":"model","display_name":"GPT-5.6 (Sol)"},
    {"id":"gpt-5.6-terra","object":"model","created":1780876800,"owned_by":"openai","type":"model","display_name":"GPT-5.6 Terra"},
    {"id":"gpt-5.6-luna","object":"model","created":1780876800,"owned_by":"openai","type":"model","display_name":"GPT-5.6 Luna"},
    {"id":"gpt-6.1-sol","object":"model","created":1790640000,"owned_by":"openai","type":"model","display_name":"GPT-6.1 Sol"},
    {"id":"gpt-6-sol","object":"model","created":1790035200,"owned_by":"openai","type":"model","display_name":"GPT-6 Sol"},
    {"id":"gpt-6-luna","object":"model","created":1790035200,"owned_by":"openai","type":"model","display_name":"GPT-6 Luna"},
    {"id":"gpt-6-astra","object":"model","created":1788480000,"owned_by":"openai","type":"model","display_name":"GPT-6 Astra"},
    {"id":"gpt-5.5","object":"model","created":1776873600,"owned_by":"openai","type":"model","display_name":"GPT-5.5"},
    {"id":"gpt-5.4","object":"model","created":1738368000,"owned_by":"openai","type":"model","display_name":"GPT-5.4"},
    {"id":"gpt-5.4-mini","object":"model","created":1738368000,"owned_by":"openai","type":"model","display_name":"GPT-5.4 Mini"},
    {"id":"gpt-5.3-codex-spark","object":"model","created":1735689600,"owned_by":"openai","type":"model","display_name":"GPT-5.3 Codex Spark"},
    {"id":"codex-auto-review","object":"model","created":1776902400,"owned_by":"openai","type":"model","display_name":"Codex Auto Review"},
    {"id":"gpt-5.2","object":"model","created":1733875200,"owned_by":"openai","type":"model","display_name":"GPT-5.2"},
    {"id":"gpt-image-1","object":"model","created":1733875200,"owned_by":"openai","type":"model","display_name":"GPT Image 1"},
    {"id":"gpt-image-1.5","object":"model","created":1735689600,"owned_by":"openai","type":"model","display_name":"GPT Image 1.5"},
    {"id":"gpt-image-2","object":"model","created":1738368000,"owned_by":"openai","type":"model","display_name":"GPT Image 2"},
    {"id":"gpt-image-2.5-flare","object":"model","created":1788825600,"owned_by":"openai","type":"model","display_name":"GPT Image 2.5 Flare"},
    {"id":"gpt-image-2.5-sunburst","object":"model","created":1788825600,"owned_by":"openai","type":"model","display_name":"GPT Image 2.5 Sunburst"}
  ],
  "anthropic": [
    {"id":"claude-fable-5-1","type":"model","display_name":"Claude Fable 5.1","created_at":"2026-09-01T00:00:00Z"},
    {"id":"claude-fable-5","type":"model","display_name":"Claude Fable 5","created_at":"2026-06-09T00:00:00Z"},
    {"id":"claude-opus-4-5-20251101","type":"model","display_name":"Claude Opus 4.5","created_at":"2025-11-01T00:00:00Z"},
    {"id":"claude-opus-4-6","type":"model","display_name":"Claude Opus 4.6","created_at":"2026-02-06T00:00:00Z"},
    {"id":"claude-opus-4-7","type":"model","display_name":"Claude Opus 4.7","created_at":"2026-04-17T00:00:00Z"},
    {"id":"claude-opus-4-8","type":"model","display_name":"Claude Opus 4.8","created_at":"2026-05-29T00:00:00Z"},
    {"id":"claude-opus-5-5","type":"model","display_name":"Claude Opus 5.5","created_at":"2026-09-22T00:00:00Z"},
    {"id":"claude-opus-5","type":"model","display_name":"Claude Opus 5","created_at":"2026-07-25T00:00:00Z"},
    {"id":"claude-sonnet-5-5","type":"model","display_name":"Claude Sonnet 5.5","created_at":"2026-09-28T00:00:00Z"},
    {"id":"claude-sonnet-5","type":"model","display_name":"Claude Sonnet 5","created_at":"2026-07-01T00:00:00Z"},
    {"id":"claude-sonnet-4-6","type":"model","display_name":"Claude Sonnet 4.6","created_at":"2026-02-18T00:00:00Z"},
    {"id":"claude-sonnet-4-5-20250929","type":"model","display_name":"Claude Sonnet 4.5","created_at":"2025-09-29T00:00:00Z"},
    {"id":"claude-haiku-4-5-20251001","type":"model","display_name":"Claude Haiku 4.5","created_at":"2025-10-01T00:00:00Z"},
    {"id":"claude-haiku-5-5","type":"model","display_name":"Claude Haiku 5.5","created_at":"2026-10-07T00:00:00Z"}
  ],
  "gemini": [
    {"id":"gemini-2.0-flash","type":"model","display_name":"Gemini 2.0 Flash","created_at":""},
    {"id":"gemini-2.5-flash","type":"model","display_name":"Gemini 2.5 Flash","created_at":""},
    {"id":"gemini-2.5-flash-image","type":"model","display_name":"Gemini 2.5 Flash Image","created_at":""},
    {"id":"gemini-2.5-pro","type":"model","display_name":"Gemini 2.5 Pro","created_at":""},
    {"id":"gemini-3.5-flash","type":"model","display_name":"Gemini 3.5 Flash","created_at":""},
    {"id":"gemini-3-flash-preview","type":"model","display_name":"Gemini 3 Flash Preview","created_at":""},
    {"id":"gemini-3-pro-preview","type":"model","display_name":"Gemini 3 Pro Preview","created_at":""},
    {"id":"gemini-3.1-pro-preview","type":"model","display_name":"Gemini 3.1 Pro Preview","created_at":""},
    {"id":"gemini-3.1-flash-image","type":"model","display_name":"Gemini 3.1 Flash Image","created_at":""}
  ]
};
