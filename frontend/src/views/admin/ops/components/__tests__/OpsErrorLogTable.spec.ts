import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import OpsErrorLogTable from '../OpsErrorLogTable.vue'
import zhLocale from '@/i18n/locales/zh'
import enLocale from '@/i18n/locales/en'
import type { OpsErrorLog } from '@/api/admin/ops'

vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()
  return {
    ...actual,
    useI18n: () => ({ t: (key: string) => key }),
  }
})

const TooltipStub = { template: '<div><slot /></div>' }
const PaginationStub = { template: '<div class="pagination-stub" />' }

function mountTable(row: Partial<OpsErrorLog>) {
  const base = {
    id: 1,
    created_at: '2026-06-05T23:59:50Z',
    phase: 'upstream',
    type: '',
    error_owner: 'provider',
    error_source: 'upstream_http',
    severity: 'error',
    status_code: 529,
    platform: 'anthropic',
    model: 'claude-opus-4-8',
    resolved: false,
    client_request_id: '',
    request_id: 'req-1',
    message: 'boom',
    user_email: '',
    account_name: '',
    group_name: '',
    ...row,
  } as OpsErrorLog

  return mount(OpsErrorLogTable, {
    props: { rows: [base], total: 1, loading: false, page: 1, pageSize: 20 },
    global: { stubs: { 'el-tooltip': TooltipStub, Pagination: PaginationStub } },
  })
}

describe('OpsErrorLogTable user/api-key/account columns', () => {
  // Regression: upstream error rows (phase=upstream, owner=provider) previously showed only the account in a single "User" column,
  // losing the user; now user/API Key/account each have a separate column, so all three are visible.
  it('renders user, api key and account in separate columns for an upstream row', () => {
    const wrapper = mountTable({
      user_id: 2,
      user_email: 'alice@test.com',
      api_key_id: 5,
      api_key_name: 'my-key',
      account_id: 9,
      account_name: 'acct-A',
    })

    const text = wrapper.text()
    expect(text).toContain('alice@test.com') // User column (also shows the user for upstream rows)
    expect(text).toContain('my-key') // API Key column
    expect(text).toContain('acct-A') // Account column
  })

  it('shows the deleted badge for a soft-deleted api key', () => {
    const wrapper = mountTable({
      api_key_id: 5,
      api_key_name: 'old-key',
      api_key_deleted: true,
    })

    expect(wrapper.text()).toContain('old-key')
    expect(wrapper.text()).toContain('admin.ops.errorLog.keyDeletedBadge')
  })
})

describe('OpsErrorLogTable column order', () => {
  it('puts time and response content first for ops without changing time sorting', async () => {
    const wrapper = mountTable({})
    await wrapper.setProps({ summaryFirst: true })

    const headers = wrapper.findAll('thead th')
    expect(headers.slice(0, 3).map((header) => header.text())).toEqual([
      'admin.ops.errorLog.time',
      'admin.ops.errorLog.message',
      'admin.ops.errorLog.user',
    ])
    expect(wrapper.findAll('tbody td')[1].text()).toBe('boom')

    await headers[0].trigger('click')
    expect(wrapper.emitted('sort')).toEqual([['created_at', 'asc']])
    wrapper.unmount()
  })

  it('preserves the usage column order and visibility by default', async () => {
    const wrapper = mountTable({})
    await wrapper.setProps({ visibleColumnKeys: ['created_at', 'user', 'message'] })

    expect(wrapper.findAll('thead th').map((header) => header.text())).toEqual([
      'admin.ops.errorLog.user',
      'admin.ops.errorLog.message',
      'admin.ops.errorLog.time',
    ])
    wrapper.unmount()
  })
})

// Regression guard: the component uses the admin.ops.errorLog.* namespace. If an i18n key uses the wrong namespace (for example, is mistakenly placed under
// errorDetail), real vue-i18n falls back to returning the key itself -> the UI displays the raw path string.
// Use the actual locale here to verify that the key resolves successfully (returning the translation rather than the key).
// Regression guard: the component uses the admin.ops.errorLog.* namespace. If a key uses the wrong namespace (for example, it is mistakenly placed under
// errorDetail), the UI displays the raw path string instead of the translation. vitest uses the runtime-only build of vue-i18n
// (without a message compiler, t() falls back to returning the key for every key), so directly verify that the locale object's namespace contains these keys.
describe('OpsErrorLogTable i18n keys exist in the errorLog namespace', () => {
  const locales: Record<string, any> = { zh: zhLocale, en: enLocale }
  for (const [name, msgs] of Object.entries(locales)) {
    it(`has apiKey & keyDeletedBadge for ${name}`, () => {
      const errorLog = msgs?.admin?.ops?.errorLog
      expect(errorLog?.apiKey).toBeTruthy()
      expect(errorLog?.keyDeletedBadge).toBeTruthy()
    })
  }
})
