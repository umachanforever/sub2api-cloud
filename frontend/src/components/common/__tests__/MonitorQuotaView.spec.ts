import { mount } from '@vue/test-utils'
import { describe, expect, it, vi } from 'vitest'

import type { MonitorQuotaSnapshot } from '@/api/admin/channelMonitor'
import MonitorQuotaView from '../MonitorQuotaView.vue'

vi.mock('vue-i18n', async () => {
  const actual = await vi.importActual<typeof import('vue-i18n')>('vue-i18n')
  return {
    ...actual,
    // te() is always truthy: known tokens directly return the i18n key, facilitating assertions for window/label mappings.
    useI18n: () => ({ t: (key: string) => key, te: () => true }),
  }
})

function makeSnapshot(overrides: Partial<MonitorQuotaSnapshot> = {}): MonitorQuotaSnapshot {
  return {
    source: 'usage',
    success: true,
    fetched_at: '2026-08-18T00:00:00Z',
    ...overrides,
  }
}

describe('MonitorQuotaView', () => {
  it('renders nothing without a snapshot', () => {
    const wrapper = mount(MonitorQuotaView, { props: { snapshot: null } })
    expect(wrapper.find('[data-testid="monitor-quota-view"]').exists()).toBe(false)
    expect(wrapper.text()).toBe('')
  })

  it('maps tier window/label tokens through i18n and colors utilization', () => {
    const wrapper = mount(MonitorQuotaView, {
      props: {
        snapshot: makeSnapshot({
          tiers: [
            { window: '5h', used_percent: 42.4 },
            { window: '7d', label: 'pro', used_percent: 80 },
            { window: 'weekly', label: 'unknown-token', used_percent: 95 },
          ],
        }),
      },
    })

    const rows = wrapper.findAll('[data-testid="monitor-quota-tier"]')
    // Render the tier row only on success and when data exists
    expect(rows).toHaveLength(3)
    const text = wrapper.text()
    // Route known window tokens through i18n
    expect(text).toContain('monitorCommon.quota.windows.5h')
    expect(text).toContain('monitorCommon.quota.windows.7d')
    // Combine known label tokens into label/window
    expect(text).toContain('monitorCommon.quota.labels.pro/monitorCommon.quota.windows.7d')
    // Pass unknown labels through unchanged (forward compatibility)
    expect(text).toContain('unknown-token/monitorCommon.quota.windows.weekly')
    // Round percentages
    expect(text).toContain('42%')
    expect(text).toContain('80%')
    expect(text).toContain('95%')

    const html = wrapper.html()
    // Threshold colors (shared by three UsageProgressBar instances): ≥90 red / ≥75 yellow / otherwise green
    // 42.4 → green, 80 → yellow, 95 → red
    expect(html).toContain('bg-green-500')
    expect(html).toContain('bg-amber-500')
    expect(html).toContain('bg-red-500')
  })

  it('clamps the tier bar width into 0-100', () => {
    const wrapper = mount(MonitorQuotaView, {
      props: {
        snapshot: makeSnapshot({ tiers: [{ window: '5h', used_percent: 240 }] }),
      },
    })
    expect(wrapper.html()).toContain('width: 100%')
  })

  it('shows the plan level badge and multi-currency balances', () => {
    const wrapper = mount(MonitorQuotaView, {
      props: {
        snapshot: makeSnapshot({
          plan_level: 'Max20',
          balances: [
            { currency: 'CNY', balance: 12.5 },
            { currency: 'USD', balance: 0 },
          ],
        }),
      },
    })

    expect(wrapper.text()).toContain('Max20')
    expect(wrapper.text()).toContain('12.50 CNY')
    expect(wrapper.text()).toContain('0.00 USD')
    // Show zero balance as a red warning
    expect(wrapper.html()).toContain('text-red-600')
  })

  it('falls back to the single balance + currency pair', () => {
    const wrapper = mount(MonitorQuotaView, {
      props: { snapshot: makeSnapshot({ balance: 3.2, currency: 'CNY' }) },
    })
    expect(wrapper.text()).toContain('3.20 CNY')
  })

  it('renders a truncated error state when the fetch failed', () => {
    const longError = 'x'.repeat(60)
    const wrapper = mount(MonitorQuotaView, {
      props: {
        snapshot: makeSnapshot({ success: false, error: longError }),
      },
    })

    const error = wrapper.get('[data-testid="monitor-quota-error"]')
    expect(error.text()).toBe(`${'x'.repeat(48)}…`)
    expect(error.attributes('title')).toBe(longError)
  })

  it('keeps failed snapshots from rendering tier rows', () => {
    const wrapper = mount(MonitorQuotaView, {
      props: {
        snapshot: makeSnapshot({
          success: false,
          tiers: [{ window: '5h', used_percent: 10 }],
        }),
      },
    })
    expect(wrapper.text()).not.toContain('10%')
  })
})
