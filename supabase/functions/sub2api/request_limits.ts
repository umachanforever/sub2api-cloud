export type RequestLimits = { server: number; gateway: number; text: number };
export const DEFAULT_REQUEST_LIMITS: RequestLimits = { server: 256 * 1024 * 1024, gateway: 256 * 1024 * 1024, text: 32 * 1024 * 1024 };
const variables = { server: 'SERVER_MAX_REQUEST_BODY_SIZE', gateway: 'GATEWAY_MAX_BODY_SIZE', text: 'GATEWAY_TEXT_MAX_BODY_SIZE' } as const;
export function resolveRequestLimits(env: Record<string, string | undefined>): RequestLimits {
  const limits = { ...DEFAULT_REQUEST_LIMITS };
  for (const field of ['server', 'gateway', 'text'] as const) {
    const value = env[variables[field]]?.trim();
    if (!value) continue;
    const number = Number(value);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < (field === 'server' ? 0 : 1)) throw Error(`Invalid ${variables[field]}`);
    limits[field] = number;
  }
  if (limits.text > limits.gateway) throw Error('GATEWAY_TEXT_MAX_BODY_SIZE must not exceed GATEWAY_MAX_BODY_SIZE');
  return limits;
}
export function requestBodyLimit(path: string, limits = DEFAULT_REQUEST_LIMITS): number {
  const route = path === "/backend-api/codex/alpha/search" || /^(?:\/v1)?\/(?:embeddings|alpha\/search|web_search|x_search|systemone)$/.test(path) ? limits.text : limits.gateway;
  return limits.server > 0 ? Math.min(limits.server, route) : route;
}
export function requestLimitSecrets(env: Record<string, string | undefined>): string {
  const limits = resolveRequestLimits(env);
  return (['server', 'gateway', 'text'] as const).map(field => `${variables[field]}=${limits[field]}\n`).join('');
}
