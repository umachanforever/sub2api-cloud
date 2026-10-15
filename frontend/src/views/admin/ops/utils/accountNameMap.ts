import { accountsAPI } from '@/api/admin/accounts'

// Ops monitoring request details only contain account_id; the frontend maps account names using the lite account list;
// a module-level cache avoids fetching all accounts every time the dialog opens.
const ACCOUNT_NAME_PAGE_SIZE = 1000

let accountNameCache: Map<string | number, string> | null = null

export async function getAccountNameMap(force = false): Promise<Map<string | number, string>> {
  if (!force && accountNameCache) return accountNameCache

  const map = new Map<string | number, string>()
  let page = 1
  let total = Number.POSITIVE_INFINITY
  while (map.size < total) {
    const res = await accountsAPI.list(page, ACCOUNT_NAME_PAGE_SIZE, {
      lite: '1',
      include_scheduler_score: '0'
    })
    total = res.total || 0
    const items = res.items || []
    if (items.length === 0) break
    for (const item of items) map.set(item.id, item.name)
    page++
  }

  accountNameCache = map
  return map
}

export function resetAccountNameCacheForTests() {
  accountNameCache = null
}
