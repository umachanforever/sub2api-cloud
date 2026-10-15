import { beforeEach, expect, it, vi } from 'vitest'

const { get } = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('@/api/client', () => ({ apiClient: { get } }))
import { getConcurrencyStats, getAccountAvailabilityStats, getRealtimeTrafficSummary } from '@/api/admin/ops'

beforeEach(() => { get.mockReset(); get.mockResolvedValue({ data: {} }) })

it.each([
  [getConcurrencyStats, '/admin/ops/concurrency'],
  [getAccountAvailabilityStats, '/admin/ops/account-availability']
])('forwards UUID pool filters', async (query, path) => {
  const group = '11111111-1111-4111-8111-111111111111'
  await query('openai', group)
  expect(get).toHaveBeenLastCalledWith(path, { params: { platform: 'openai', group_id: group } })
  await query('', null)
  expect(get).toHaveBeenLastCalledWith(path, { params: {} })
})

it('forwards the realtime window and UUID pool', async () => {
  const group = '11111111-1111-4111-8111-111111111111'
  await getRealtimeTrafficSummary('5min', 'gemini', group)
  expect(get).toHaveBeenCalledWith('/admin/ops/realtime-traffic', { params: { window: '5min', platform: 'gemini', group_id: group } })
})
