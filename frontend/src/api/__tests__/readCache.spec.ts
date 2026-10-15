import { describe, expect, it, vi } from 'vitest'
import axios, { AxiosHeaders, type AxiosAdapter, type InternalAxiosRequestConfig } from 'axios'
import { createReadCache } from '../readCache'

const config = (url = '/admin/accounts', extra = {}): InternalAxiosRequestConfig => ({
  url, method: 'get', headers: new AxiosHeaders({ Authorization: 'Bearer first' }), ...extra
})
const response = (c: InternalAxiosRequestConfig, value = 1) => ({
  data: { code: 0, data: { value } }, status: 200, statusText: 'OK', headers: {}, config: c
})

describe('management read cache', () => {
  it('caches raw JSON from the Axios transport before response transforms', async () => {
    const source = vi.fn(async c => ({ ...response(c), data: JSON.stringify({ code: 0, data: [1] }) }))
    const client = axios.create({ adapter: createReadCache(source) })
    const headers = { Authorization: 'Bearer first' }
    expect((await client.get('/admin/accounts', { headers })).data.data).toEqual([1])
    expect((await client.get('/admin/accounts', { headers })).data.data).toEqual([1])
    expect(source).toHaveBeenCalledTimes(1)
  })
  it('caches every query for a minute, isolates callers, and partitions filters', async () => {
    let now = 0
    const source = vi.fn(async c => response(c))
    const cached = createReadCache(source, () => now)
    const first = await cached(config())
    first.data.data.value = 99
    expect((await cached(config())).data.data.value).toBe(1)
    expect(source).toHaveBeenCalledTimes(1)
    await cached(config('/admin/accounts', { params: { page: 2 } }))
    await cached(config('/usage'))
    now = 59_999
    await cached(config('/usage'))
    await cached(config())
    expect(source).toHaveBeenCalledTimes(3)
    now = 60_001
    await cached(config())
    await cached(config('/usage'))
    expect(source).toHaveBeenCalledTimes(5)
  })

  it('includes dashboard details, settings, users, and account usage', async () => {
    const source = vi.fn(async c => response(c))
    const cached = createReadCache(source)
    for (const path of ['/admin/dashboard/snapshot-v2', '/admin/users', '/admin/settings', '/admin/accounts/42/usage', '/subscriptions']) {
      await cached(config(path)); await cached(config(path))
    }
    expect(source).toHaveBeenCalledTimes(5)
  })

  it('caches POST batch queries by body without invalidating other reads', async () => {
    const source = vi.fn(async c => response(c))
    const cached = createReadCache(source)
    await cached(config())
    for (const path of ['/admin/accounts/usage/batch', '/admin/accounts/today-stats/batch', '/admin/dashboard/users-usage', '/admin/dashboard/api-keys-usage', '/usage/dashboard/api-keys-usage']) {
      const c = config(path, { method: 'post', data: '{"ids":[1]}' })
      await cached(c); await cached(c)
      await cached(config(path, { method: 'post', data: '{"ids":[2]}' }))
    }
    await cached(config())
    expect(source).toHaveBeenCalledTimes(11)
  })

  it('never caches auth, writes, failures, conditional requests, or explicit refreshes', async () => {
    const source = vi.fn(async c => response(c))
    const cached = createReadCache(source)
    for (const c of [config('/auth/me'), config('/admin/accounts', { method: 'post' }),
      config('/admin/accounts', { headers: new AxiosHeaders({ Authorization: 'Bearer first', 'Cache-Control': 'no-cache' }) }),
      config('/admin/accounts', { headers: new AxiosHeaders({ Authorization: 'Bearer first', 'If-None-Match': 'etag' }) })]) {
      await cached(c); await cached(c)
    }
    expect(source).toHaveBeenCalledTimes(8)
    const failed = vi.fn(async c => ({ ...response(c), data: { code: 1 } }))
    const failures = createReadCache(failed)
    await failures(config()); await failures(config())
    expect(failed).toHaveBeenCalledTimes(2)
  })

  it('clears snapshots on session changes and mutations, including failed writes', async () => {
    const source = vi.fn(async c => {
      if (c.method === 'post') throw Error('write failed')
      return response(c)
    })
    const cached = createReadCache(source)
    await cached(config()); await cached(config())
    await expect(cached(config('/keys', { method: 'post' }))).rejects.toThrow()
    await cached(config())
    await cached(config('/admin/accounts', { headers: new AxiosHeaders({ Authorization: 'Bearer second' }) }))
    expect(source).toHaveBeenCalledTimes(4)
  })

  it('invalidates snapshots on manual refresh', async () => {
    const source = vi.fn(async c => response(c))
    const cached = createReadCache(source)
    await cached(config()); await cached(config())
    cached.invalidate()
    await cached(config())
    expect(source).toHaveBeenCalledTimes(2)
  })

  it('coalesces reads but does not repopulate stale snapshots after a mutation', async () => {
    let finish!: (value: ReturnType<typeof response>) => void
    const source = vi.fn<AxiosAdapter>(c => c.method === 'post' ? Promise.resolve(response(c)) : new Promise(resolve => { finish = resolve }))
    const cached = createReadCache(source)
    const first = cached(config())
    const second = cached(config())
    expect(source).toHaveBeenCalledTimes(1)
    await cached(config('/keys', { method: 'post' }))
    finish(response(config()))
    await Promise.all([first, second])
    const third = cached(config())
    expect(source).toHaveBeenCalledTimes(3)
    finish(response(config())); await third
    const controller = new AbortController(); controller.abort()
    await expect(cached(config('/admin/accounts', { signal: controller.signal }))).rejects.toSatisfy(axios.isCancel)
  })
})
