import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import type { AdminUser } from '@/types'
import UserAllowedGroupsModal from '../UserAllowedGroupsModal.vue'

const mocks = vi.hoisted(() => ({ list: vi.fn(), update: vi.fn() }))
vi.mock('@/api/admin', () => ({ adminAPI: { groups: { list: mocks.list }, users: { update: mocks.update } } }))
vi.mock('@/stores/app', () => ({ useAppStore: () => ({ showSuccess: vi.fn(), showError: vi.fn() }) }))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))
enableAutoUnmount(afterEach)
afterEach(() => vi.restoreAllMocks())
const response = { items: [{ id: 7, name: 'Exclusive', platform: 'openai', is_exclusive: true, subscription_type: 'standard', status: 'active', rate_multiplier: 1 }] }
beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  mocks.list.mockResolvedValue(response)
  mocks.update.mockResolvedValue(undefined)
})
async function openDialog() {
  const wrapper = mount(UserAllowedGroupsModal, {
    props: { show: false, user: { id: 1, email: 'user@example.com', allowed_groups: [7], group_rates: { 7: 0.5 } } as AdminUser },
    global: { stubs: { BaseDialog: { props: ['show'], template: '<div v-if="show"><slot /><slot name="footer" /></div>' }, PlatformIcon: true } }
  })
  await wrapper.setProps({ show: true })
  return wrapper
}

describe('UserAllowedGroupsModal load readiness', () => {
  it('cannot save an empty configuration while groups are loading', async () => {
    let resolve!: (value: typeof response) => void
    mocks.list.mockReturnValueOnce(new Promise(res => { resolve = res }))
    const wrapper = await openDialog()
    const save = wrapper.get('button.btn-primary')
    expect(save.attributes('disabled')).toBeDefined()
    await save.trigger('click')
    expect(mocks.update).not.toHaveBeenCalled()
    resolve(response)
    await flushPromises()
    expect(save.attributes('disabled')).toBeUndefined()
  })

  it('cannot save after loading fails', async () => {
    mocks.list.mockRejectedValueOnce(new Error('Offline'))
    const wrapper = await openDialog()
    await flushPromises()
    const save = wrapper.get('button.btn-primary')
    expect(save.attributes('disabled')).toBeDefined()
    await save.trigger('click')
    expect(mocks.update).not.toHaveBeenCalled()
  })

  it('does not reuse a previous successful load after reopening fails', async () => {
    const wrapper = await openDialog()
    await flushPromises()
    await wrapper.setProps({ show: false })
    mocks.list.mockRejectedValueOnce(new Error('Offline'))
    await wrapper.setProps({ show: true })
    await flushPromises()
    expect(wrapper.get('button.btn-primary').attributes('disabled')).toBeDefined()
    expect(mocks.update).not.toHaveBeenCalled()
  })

  it('preserves existing grants and rates on a successful save', async () => {
    const wrapper = await openDialog()
    await flushPromises()
    await wrapper.get('button.btn-primary').trigger('click')
    await flushPromises()
    expect(mocks.update).toHaveBeenCalledWith(1, { allowed_groups: [7], restrict_public_groups: false, group_rates: { 7: 0.5 } })
    expect(wrapper.emitted('success')).toHaveLength(1)
  })
})

it('loads every page using the supported page size before saving UUID groups and dedicated rates', async () => {
  const userId='11111111-1111-4111-8111-111111111111',first='22222222-2222-4222-8222-222222222222',second='33333333-3333-4333-8333-333333333333';
  mocks.list.mockResolvedValueOnce({ ...response, pages: 2, items: [{ ...response.items[0], id: first }] }).mockResolvedValueOnce({ ...response, pages: 2, items: [{ ...response.items[0], id: second, name: 'Second' }] });
  const wrapper=mount(UserAllowedGroupsModal,{props:{show:false,user:{id:userId,email:'user@example.com',allowed_groups:[first,second],group_rates:{[second]:0.5}} as unknown as AdminUser},global:{stubs:{BaseDialog:{props:['show'],template:'<div v-if="show"><slot /><slot name="footer" /></div>'},PlatformIcon:true}}});
  await wrapper.setProps({show:true});await flushPromises();
  expect(mocks.list.mock.calls).toEqual([[1,100],[2,100]]);
  await wrapper.get('button.btn-primary').trigger('click');await flushPromises();
  expect(mocks.update).toHaveBeenCalledWith(userId,{allowed_groups:[first,second],restrict_public_groups:false,group_rates:{[second]:0.5}});
});


it('saves the public group restriction switch with its selected grants', async () => {
  mocks.list.mockResolvedValue({ ...response, items: [{ ...response.items[0], is_exclusive: false }] })
  const wrapper = await openDialog()
  await flushPromises()
  await wrapper.get('label.ml-auto input[type="checkbox"]').setValue(true)
  await wrapper.get('button.btn-primary').trigger('click')
  await flushPromises()
  expect(mocks.update).toHaveBeenCalledWith(1, { allowed_groups: [7], restrict_public_groups: true, group_rates: { 7: 0.5 } })
})
