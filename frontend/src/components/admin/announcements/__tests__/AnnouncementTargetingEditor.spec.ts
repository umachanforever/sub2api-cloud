import { describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import AnnouncementTargetingEditor from '../AnnouncementTargetingEditor.vue'
import type { AdminGroup, AnnouncementTargeting } from '@/types'
vi.mock('@/stores', () => ({ useAuthStore: () => ({ isSimpleMode: false }) }))
vi.mock('vue-i18n', async () => ({ ...await vi.importActual<typeof import('vue-i18n')>('vue-i18n'), useI18n: () => ({ t: (key: string) => key }) }))

describe('announcement UUID targeting', () => {
  it('keeps existing UUID selections and adds a second subscription group without coercion', async () => {
    vi.useFakeTimers()
    const first = '11111111-1111-4111-8111-111111111111'
    const second = '22222222-2222-4222-8222-222222222222'
    const wrapper = mount(AnnouncementTargetingEditor, {
      props: {
        modelValue: { any_of: [{ all_of: [{ type: 'subscription', operator: 'in', group_ids: [first] }] }] } as unknown as AnnouncementTargeting,
        groups: [first, second].map((id, i) => ({ id, name: `Plan ${i}`, platform: 'openai', subscription_type: 'subscription', status: 'active' })) as unknown as AdminGroup[],
      },
      global: { stubs: { Icon: true, Select: true, GroupBadge: true } },
    })
    try {
      await flushPromises()
      const choices = wrapper.findAll<HTMLInputElement>('input[type="checkbox"]')
      expect(choices).toHaveLength(2)
      expect(choices[0].element.checked).toBe(true)
      await choices[1].setValue(true)
      await vi.advanceTimersByTimeAsync(1)
      const update = wrapper.emitted('update:modelValue')?.at(-1)?.[0] as AnnouncementTargeting
      expect(update.any_of?.[0].all_of?.[0].group_ids).toEqual([first, second])
    } finally { wrapper.unmount(); vi.useRealTimers() }
  })
})
