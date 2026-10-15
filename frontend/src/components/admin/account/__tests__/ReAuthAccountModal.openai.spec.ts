import { defineComponent } from 'vue'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ generateAuthUrl: vi.fn(), exchangeCode: vi.fn(), update: vi.fn(), applyOAuthCredentials: vi.fn(), clearError: vi.fn(), showError: vi.fn(), showSuccess: vi.fn() }))
vi.mock('@/stores/app', () => ({ useAppStore: () => mocks }))
vi.mock('vue-i18n', async () => ({ ...await vi.importActual<typeof import('vue-i18n')>('vue-i18n'), useI18n: () => ({ t: (key: string) => key }) }))
vi.mock('@/api/admin', () => ({ adminAPI: { accounts: mocks } }))
import AdminModal from '../ReAuthAccountModal.vue'
import AccountModal from '@/components/account/ReAuthAccountModal.vue'
const Dialog = defineComponent({ template: '<div><slot/><slot name="footer"/></div>' })
const Flow = defineComponent({
  name: 'OAuthAuthorizationFlow', data: () => ({ authCode: 'one-use-code', oauthState: 'state', inputMethod: 'manual' }),
  emits: ['generate-url'], template: '<button data-testid="generate" @click="$emit(\'generate-url\')">generate</button>'
})
const account = { id: 42, name: 'existing', platform: 'openai', type: 'oauth', status: 'active', proxy_id: null, extra: { custom: 'preserved' } }
enableAutoUnmount(afterEach)
beforeEach(() => {
  vi.resetAllMocks()
  mocks.generateAuthUrl.mockResolvedValue({ auth_url: 'https://auth.openai.com/authorize?state=state', session_id: 'native-pkce-session' })
  mocks.exchangeCode.mockResolvedValue({ oauth_ticket_id: 'opaque-ticket' })
  mocks.update.mockImplementation(async (_id, fields) => ({ ...account, ...fields }))
  mocks.applyOAuthCredentials.mockResolvedValue({ ...account, status: 'inactive' })
})
describe.each([['admin', AdminModal], ['legacy', AccountModal]] as const)('%s OpenAI reauthorization', (_label, component) => {
  async function open(status = 'active') {
    const wrapper = mount(component, { props: { show: true, account: { ...account, status } as any }, global: { stubs: { BaseDialog: Dialog, OAuthAuthorizationFlow: Flow, Icon: true } } })
    await wrapper.get('[data-testid="generate"]').trigger('click')
    await flushPromises()
    return wrapper
  }
  it('pauses before applying ticket and restores active status while preserving extra settings', async () => {
    const wrapper = await open()
    await wrapper.get('.btn-primary').trigger('click'); await flushPromises()
    expect(mocks.update.mock.calls).toEqual([[42, { status: 'inactive' }], [42, { status: 'active' }]])
    expect(mocks.update.mock.invocationCallOrder[0]).toBeLessThan(mocks.applyOAuthCredentials.mock.invocationCallOrder[0])
    expect(mocks.applyOAuthCredentials).toHaveBeenCalledWith(42, { type: 'oauth', credentials: { oauth_ticket_id: 'opaque-ticket' }, extra: undefined })
    expect(mocks.applyOAuthCredentials.mock.invocationCallOrder[0]).toBeLessThan(mocks.update.mock.invocationCallOrder[1])
    expect(mocks.clearError).not.toHaveBeenCalled()
    expect(wrapper.emitted('reauthorized')).toHaveLength(1)
    expect(wrapper.emitted('close')).toHaveLength(1)
  })
  it('retries in-flight conflicts with cached ticket, leaves account paused, and reports the server error', async () => {
    mocks.applyOAuthCredentials.mockRejectedValueOnce({ response: { data: { message: 'account_has_active_requests' } } })
    const wrapper = await open()
    await wrapper.get('.btn-primary').trigger('click'); await flushPromises()
    expect(mocks.update.mock.calls).toEqual([[42, { status: 'inactive' }]])
    expect(mocks.showError).toHaveBeenCalledWith('account_has_active_requests')
    expect(wrapper.get('.btn-primary').attributes('disabled')).toBeUndefined()
    expect(wrapper.emitted('close')).toBeUndefined()
    await wrapper.get('.btn-primary').trigger('click'); await flushPromises()
    expect(mocks.exchangeCode).toHaveBeenCalledTimes(1)
    expect(mocks.applyOAuthCredentials).toHaveBeenCalledTimes(2)
    expect(mocks.update.mock.calls.at(-1)).toEqual([42, { status: 'active' }])
  })
  it('does not reactivate an account that was already inactive', async () => {
    const wrapper = await open('inactive')
    await wrapper.get('.btn-primary').trigger('click'); await flushPromises()
    expect(mocks.update.mock.calls).toEqual([[42, { status: 'inactive' }]])
  })
  it('retries failed reactivation without consuming the applied ticket twice', async () => {
    mocks.update.mockResolvedValueOnce({ ...account, status: 'inactive' }).mockRejectedValueOnce(new Error('restore unavailable')).mockResolvedValueOnce(account)
    const wrapper = await open()
    await wrapper.get('.btn-primary').trigger('click'); await flushPromises()
    expect(wrapper.emitted('close')).toBeUndefined()
    await wrapper.get('.btn-primary').trigger('click'); await flushPromises()
    expect(mocks.applyOAuthCredentials).toHaveBeenCalledTimes(1)
    expect(mocks.exchangeCode).toHaveBeenCalledTimes(1)
    expect(wrapper.emitted('reauthorized')).toHaveLength(1)
  })
})
