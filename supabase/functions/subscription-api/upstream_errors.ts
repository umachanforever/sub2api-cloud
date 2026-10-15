// Expose only fixed error categories; provider messages can contain account data.
export async function upstreamErrorCode(response: Response): Promise<string> {
  const fallback = 'upstream_rejected_request';
  if (response.status !== 400 && response.status !== 404) return fallback;
  const reader = response.body?.getReader();
  if (!reader) return fallback;
  const chunks: Uint8Array[] = [];
  let size = 0;
  const timer = setTimeout(() => { void reader.cancel().catch(() => {}); }, 2000);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16384) return fallback;
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const body = JSON.parse(new TextDecoder().decode(bytes));
    const error = body?.error;
    const code = typeof error?.code === 'string' ? error.code.toLowerCase() : '';
    const message = typeof error?.message === 'string' ? error.message.toLowerCase() : typeof body?.detail === 'string' ? body.detail.toLowerCase() : '';
    if (['model_not_found', 'invalid_model', 'unknown_model'].includes(code)) return 'upstream_model_not_found';
    if (['model_access_denied', 'model_not_available'].includes(code)) return 'upstream_model_access_denied';
    if (/model.{0,240}(?:not supported|unsupported).{0,240}(?:account|subscription|plan)/s.test(message)) return 'upstream_model_access_denied';
    if (['unsupported_model', 'model_not_supported'].includes(code)) return 'upstream_model_unsupported';
    if (/model.{0,240}(?:does not exist|not found|unknown model)/s.test(message)) return 'upstream_model_not_found';
    if (/model.{0,240}(?:not supported|unsupported)/s.test(message)) return 'upstream_model_unsupported';
    return fallback;
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
