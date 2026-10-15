import { beforeEach, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import OpsConcurrencyCard from '../OpsConcurrencyCard.vue'

const api = vi.hoisted(() => ({ getConcurrencyStats: vi.fn(), getAccountAvailabilityStats: vi.fn(), getUserConcurrencyStats: vi.fn() }))
vi.mock('@/api/admin/ops', () => ({ opsAPI: api }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
const group = '11111111-1111-4111-8111-111111111111'
const account = '22222222-2222-4222-8222-222222222222'

beforeEach(() => {
  vi.clearAllMocks()
  api.getConcurrencyStats.mockResolvedValue({ enabled: true, account: { [account]: { account_id: account, account_name: 'Quota paused', group_id: group, current_in_use: 1, max_capacity: 3 } } })
  api.getAccountAvailabilityStats.mockResolvedValue({ enabled: true, account: { [account]: { account_id: account, group_id: group, is_rate_limited: true } } })
  api.getUserConcurrencyStats.mockResolvedValue({ enabled: true, user: { [account]: { user_id: account, username: '', user_email: '', current_in_use: 1, max_capacity: 0 } } })
})

it('refreshes a disabled card after monitoring is enabled again', async () => {
  api.getConcurrencyStats.mockResolvedValueOnce({ enabled: false, account: {} })
  api.getAccountAvailabilityStats.mockResolvedValueOnce({ enabled: false, account: {} })
  const wrapper = mount(OpsConcurrencyCard, { props: { refreshToken: 0, groupIdFilter: group } })
  await flushPromises()
  expect(wrapper.text()).toContain('admin.ops.concurrency.disabledHint')
  await wrapper.setProps({ refreshToken: 1 })
  await flushPromises()
  expect(wrapper.text()).toContain('Quota paused')
  expect(wrapper.text()).not.toContain('admin.ops.concurrency.disabledHint')
  wrapper.unmount()
})

it('renders UUID pools, unknown recovery and unlimited users', async () => {
  const wrapper = mount(OpsConcurrencyCard, { props: { refreshToken: 0, platformFilter: 'openai', groupIdFilter: group } })
  await flushPromises()
  expect(api.getConcurrencyStats).toHaveBeenCalledWith('openai', group)
  expect(api.getAccountAvailabilityStats).toHaveBeenCalledWith('openai', group)
  expect(wrapper.text()).toContain('Quota paused')
  expect(wrapper.text()).toContain('-')
  expect(wrapper.text()).not.toContain('0s')
  await wrapper.get('[title="admin.ops.concurrency.switchToUser"]').trigger('click')
  await flushPromises()
  expect(api.getUserConcurrencyStats).toHaveBeenCalledWith()
  expect(wrapper.text()).toContain(account)
  expect(wrapper.text()).toContain('1/∞')
  wrapper.unmount()
})
