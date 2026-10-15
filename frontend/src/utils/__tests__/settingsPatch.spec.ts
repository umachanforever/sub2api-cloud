import { describe, expect, it } from 'vitest'
import { changedSettings } from '../settingsPatch'

describe('settings updates', () => {
  it('omits unchanged defaults and keeps every changed field including disabled values', () => {
    const saved = { site_name: 'Gateway', registration_enabled: true, unrelated: false, balance: 1, nested: [{ days: 30 }] }
    expect(changedSettings(saved, structuredClone(saved))).toEqual({})
    expect(changedSettings(saved, { ...saved, registration_enabled: false, balance: 0, unrelated: true, nested: [] })).toEqual({ registration_enabled: false, balance: 0, unrelated: true, nested: [] })
  })
  it('compares nested settings by value', () => {
    expect(changedSettings({ nested: [{ days: 30 }] }, { nested: [{ days: 15 }] })).toEqual({ nested: [{ days: 15 }] })
  })
})

import { normalizeDefaultSubscriptionSettings } from '@/api/admin/settings'
it('keeps UUID subscription groups and validates legacy numeric IDs', () => {
  const group = '11111111-1111-4111-8111-111111111111'
  expect(normalizeDefaultSubscriptionSettings([
    { group_id: group, validity_days: 15 },
    { group_id: 2, validity_days: 30 },
    { group_id: 'bad', validity_days: 30 },
    { group_id: 0, validity_days: 30 },
    { group_id: group, validity_days: Number.NaN },
  ])).toEqual([{ group_id: group, validity_days: 15 }, { group_id: 2, validity_days: 30 }])
})
