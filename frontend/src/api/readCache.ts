import axios, { type AxiosAdapter, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios'

// Keep successful query snapshots in this tab for one minute.
export function createReadCache(adapter: AxiosAdapter, now = Date.now): AxiosAdapter & { invalidate(): void } {
  const entries = new Map<string, { expires: number; response: AxiosResponse }>()
  const pending = new Map<string, Promise<AxiosResponse>>()
  let session: string | undefined
  let generation = 0
  let mutations = 0
  const clear = () => { entries.clear(); pending.clear(); generation++ }
  const copy = (response: AxiosResponse, config: InternalAxiosRequestConfig): AxiosResponse =>
    ({ ...response, data: structuredClone(response.data), config })

  const cachedAdapter: AxiosAdapter = async config => {
    const identity = String(config.headers.get('Authorization') || '')
    if (session !== identity) { clear(); session = identity }
    const method = (config.method || 'get').toLowerCase()
    const path = (config.url || '').split('?')[0]
    // These POST endpoints only read batch statistics; their bodies partition snapshots.
    const batchQuery = method === 'post' && /^(?:\/admin\/accounts\/(?:usage|today-stats)\/batch|\/admin\/dashboard\/(?:users|api-keys)-usage|\/usage\/dashboard\/api-keys-usage)$/.test(path)
    if (!['get', 'head', 'options'].includes(method) && !batchQuery) {
      clear(); mutations++
      try { return await adapter(config) } finally { mutations--; clear() }
    }
    const ttl = 60_000
    const bypass = /no-cache|no-store/i.test(String(config.headers.get('Cache-Control') || ''))
    if (bypass) clear()
    const eligible = (method === 'get' || batchQuery) && !!identity && !mutations &&
      !/(?:^|\/)(?:auth|oauth|setup|credentials|authorize|authorization|callback|export|data|stream|events)(?:\/|$)/i.test(path) &&
      !config.headers.has('If-None-Match') && !config.responseType &&
      !bypass
    if (!eligible) return adapter(config)
    if (config.signal?.aborted) throw new axios.CanceledError()
    const key = method + '\n' + axios.getUri(config) + '\n' + String(config.headers.get('Accept-Language') || '') + '\n' + (batchQuery ? JSON.stringify(config.data) : '')
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
  return Object.assign(cachedAdapter, { invalidate: clear })
}
