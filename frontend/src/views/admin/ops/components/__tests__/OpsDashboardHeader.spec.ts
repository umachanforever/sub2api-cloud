import { describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import OpsDashboardHeader from '../OpsDashboardHeader.vue'
import type { OpsDashboardOverview } from '@/api/admin/ops'
import { opsAPI } from '@/api/admin/ops'

vi.mock('@/api', () => ({ adminAPI: { groups: { getAll: vi.fn().mockResolvedValue([]) } } }))
vi.mock('@/api/admin/ops', () => ({ opsAPI: { getRealtimeTrafficSummary: vi.fn().mockResolvedValue({ enabled: true, summary: null }) } }))
vi.mock('@/stores', () => ({ useAdminSettingsStore: () => ({ opsRealtimeMonitoringEnabled: true, setOpsRealtimeMonitoringEnabledLocal: vi.fn() }) }))
vi.mock('vue-i18n', async () => ({
  ...await vi.importActual<typeof import('vue-i18n')>('vue-i18n'),
  useI18n: () => ({ t: (key: string, params?: Record<string, unknown>) => params ? `${key}:${JSON.stringify(params)}` : key })
}))

const overview = { tps: { avg: 242.7 } } as OpsDashboardOverview
function mountHeader(value = overview) {
  return mount(OpsDashboardHeader, {
    props: { overview: value, platform: '', groupId: null, timeRange: '1h', queryMode: 'auto', loading: false, lastUpdated: null },
    global: { stubs: { Select: true, HelpTooltip: true, BaseDialog: true, Icon: true } }
  })
}

describe('OpsDashboardHeader output TPS', () => {
  it('identifies aggregate totals without complete retained detail records', async () => {
    const wrapper = mountHeader({ ...overview, raw_samples_complete: false })
    await flushPromises()
    expect(wrapper.get('[data-testid="retained-samples-differ"]').text()).toContain('admin.ops.retainedSamplesDiffer')
    await wrapper.setProps({ overview: { ...overview, raw_samples_complete: true } })
    expect(wrapper.find('[data-testid="retained-samples-differ"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('identifies missing usage within the selected realtime window', async () => {
    vi.mocked(opsAPI.getRealtimeTrafficSummary).mockResolvedValueOnce({ enabled: true, summary: { window: '1min', start_time: '', end_time: '', platform: '', qps: { current: 1, peak: 1, avg: 1 }, tps: { current: 2, peak: 2, avg: 2 }, unknown_token_attempts: 3 } })
    const wrapper = mountHeader()
    await flushPromises()
    expect(wrapper.get('[data-testid="realtime-unknown-tokens"]').text()).toContain('"count":3')
    wrapper.unmount()
  })

  it('identifies partial token totals when an upstream attempt did not report usage', async () => {
    const wrapper = mountHeader({ ...overview, token_consumed: 21, unknown_token_attempts: 1 })
    await flushPromises()
    expect(wrapper.text()).toContain('admin.ops.knownTokens')
    expect(wrapper.get('[data-testid="unknown-token-attempts"]').text()).toContain('"count":1')
    await wrapper.setProps({ overview: { ...overview, token_consumed: 21, unknown_token_attempts: 0 } })
    expect(wrapper.find('[data-testid="unknown-token-attempts"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('shows per-request P50, slower-tail percentiles and sample count separately from traffic TPS', async () => {
    const wrapper = mountHeader({ ...overview, output_tps: { p5: 2.35, p10: 3.7, p50: 55, avg: 277.75, sample_count: 4 } })
    await flushPromises()
    const card = wrapper.get('[data-testid="output-tps-card"]')
    expect(card.get('[data-testid="output-tps-p50"]').text()).toBe('55.0')
    expect(card.get('[data-testid="output-tps-p5"]').text()).toBe('2.4')
    expect(card.get('[data-testid="output-tps-p10"]').text()).toBe('3.7')
    expect(card.get('[data-testid="output-tps-avg"]').text()).toBe('277.8')
    expect(card.get('[data-testid="output-tps-samples"]').text()).toContain('4')
    expect(card.text()).toContain('tok/s (P50)')
    expect(card.text()).not.toContain('242.7')
    await wrapper.setProps({ fullscreen: true, overview: { ...overview, output_tps: { p5: 0.01, p10: 0.02, p50: 0.04, avg: 0.05, sample_count: 1 } } })
    expect(card.get('[data-testid="output-tps-p50"]').text()).toBe('0.0')
    expect(card.get('[data-testid="output-tps-samples"]').text()).toContain('1')
    wrapper.unmount()
  })

  it.each([undefined, null, { p5: null, p10: null, p50: null, avg: null, sample_count: 0 }])('shows missing output TPS as unavailable, not zero: %s', async (output_tps) => {
    const wrapper = mountHeader({ ...overview, output_tps })
    await flushPromises()
    for (const metric of ['p5', 'p10', 'p50', 'avg']) {
      expect(wrapper.get(`[data-testid="output-tps-${metric}"]`).text()).toBe('—')
    }
    expect(wrapper.get('[data-testid="output-tps-samples"]').text()).toContain(output_tps == null ? '—' : '0')
    wrapper.unmount()
  })

})

describe('configured metric highlighting', () => {
  it('applies saved thresholds and removes highlighting when they are disabled', async () => {
    const wrapper = mountHeader({ ...overview, sla: 0.98, request_count_sla: 10, error_rate: 0.1, upstream_error_rate: 0.1, ttft: { p99_ms: 600 } })
    await wrapper.setProps({ thresholds: { sla_percent_min: 99.5, ttft_p99_ms_max: 500, request_error_rate_percent_max: 5, upstream_error_rate_percent_max: 5 } })
    await flushPromises()
    for (const value of ['98.000%', '600', '10.00%']) {
      const metrics = wrapper.findAll('div').filter(element => element.classes().includes('font-black') && element.text().trim() === value)
      expect(metrics.length).toBeGreaterThan(0)
      expect(metrics.every(element => element.classes().includes('text-red-600'))).toBe(true)
    }
    await wrapper.setProps({ thresholds: { sla_percent_min: null, ttft_p99_ms_max: null, request_error_rate_percent_max: null, upstream_error_rate_percent_max: null } })
    expect(wrapper.findAll('.font-black.text-red-600')).toHaveLength(0)
    wrapper.unmount()
  })
})
