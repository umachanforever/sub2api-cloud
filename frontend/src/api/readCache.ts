import axios, { type AxiosAdapter, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios'

// Keep list snapshots in this tab only; credentials and identity endpoints are excluded.
export function createReadCache(adapter: AxiosAdapter, now = Date.now): AxiosAdapter {
  const entries = new Map<string, { expires: number; response: AxiosResponse }>()
  const pending = new Map<string, Promise<AxiosResponse>>()
  let session: string | undefined
  let generation = 0
  let mutations = 0
  const clear = () => { entries.clear(); pending.clear(); generation++ }
  const copy = (response: AxiosResponse, config: InternalAxiosRequestConfig): AxiosResponse =>
    ({ ...response, data: structuredClone(response.data), config })

  return async config => {
    const identity = String(config.headers.get('Authorization') || '')
    if (session !== identity) { clear(); session = identity }
    const method = (config.method || 'get').toLowerCase()
    if (!['get', 'head', 'options'].includes(method)) {
      clear(); mutations++
      try { return await adapter(config) } finally { mutations--; clear() }
    }
    const path = (config.url || '').split('?')[0]
    const ttl = /^\/(?:usage(?:\/|$)|admin\/dashboard\/)/.test(path) ? 5000 : 15000
    const bypass = /no-cache|no-store/i.test(String(config.headers.get('Cache-Control') || ''))
    if (bypass) clear()
    const eligible = method === 'get' && !!identity && !mutations &&
      (/^\/(?:admin\/accounts|admin\/groups|groups|keys)$/.test(path) ||
       /^\/(?:usage(?:\/dashboard\/[\w-]+|\/stats)?|admin\/dashboard\/[\w-]+)$/.test(path)) &&
      !config.headers.has('If-None-Match') && !config.responseType &&
      !bypass
    if (!eligible) return adapter(config)
    if (config.signal?.aborted) throw new axios.CanceledError()
    const key = axios.getUri(config) + '\n' + String(config.headers.get('Accept-Language') || '')
    const cached = entries.get(key)
    if (cached && cached.expires > now()) return copy(cached.response, config)
    entries.delete(key)
    // Requests with caller-owned cancellation remain independent.
    const shared = !config.signal && pending.get(key)
    if (shared) return copy(await shared, config)
    const version = generation
    const request = adapter(config).then(response => {
      let successful = false
      try {
        const encoded = typeof response.data === 'string' ? response.data : JSON.stringify(response.data)
        successful = encoded.length <= 1_000_000 && JSON.parse(encoded)?.code === 0
      } catch { /* Non-JSON responses are never cached. */ }
      if (version === generation && response.status === 200 && successful) {
        if (entries.size >= 64) entries.delete(entries.keys().next().value!)
        entries.set(key, { expires: now() + ttl, response: copy(response, config) })
      }
      return response
    })
    if (!config.signal) pending.set(key, request)
    try { return copy(await request, config) } finally {
      if (pending.get(key) === request) pending.delete(key)
    }
  }
}
