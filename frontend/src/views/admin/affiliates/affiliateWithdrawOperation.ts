/** An offline withdrawal registration and the idempotency key identifying it. */
export interface AffiliateWithdrawOperation {
  userId: number
  amount: number
  key: string
  storageKey: string | null
  outcomeUncertain: boolean
}

// Rebate balances are recorded to 8 decimal places.
const LEDGER_SCALE = 1e8

const pendingKeys = new Map<string, string>()

function currentAdminId(): number | null {
  try {
    const user = JSON.parse(globalThis.localStorage?.getItem('auth_user') ?? 'null') as { id?: unknown } | null
    const id = user?.id
    return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id : null
  } catch {
    return null
  }
}

function readStoredKey(storageKey: string): string | null {
  try {
    return globalThis.sessionStorage?.getItem(storageKey) ?? null
  } catch {
    return null
  }
}

function storeKey(storageKey: string, key: string | null) {
  try {
    if (key) globalThis.sessionStorage?.setItem(storageKey, key)
    else globalThis.sessionStorage?.removeItem(storageKey)
  } catch {
    // When browser storage is unavailable, the in-memory key still protects retries within the same page.
  }
}

/**
 * Get the registration for this user and amount. A registration with an unknown result retains its key until completion;
 * resubmitting the same user and amount reuses that key, allowing the server to return the initial result without another deduction.
 */
export function prepareAffiliateWithdrawOperation(userId: number, amount: number): AffiliateWithdrawOperation {
  const normalizedAmount = Math.round(amount * LEDGER_SCALE) / LEDGER_SCALE
  const adminId = currentAdminId()
  const storageKey = adminId ? `sub2api:admin:affiliate-withdraw:${adminId}:${userId}:${normalizedAmount}` : null
  let key = storageKey ? pendingKeys.get(storageKey) ?? readStoredKey(storageKey) : null
  const outcomeUncertain = !!key
  if (!key) {
    const requestId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
    key = `affiliate-withdraw-${adminId ?? 'unknown'}-${requestId}`
  }
  if (storageKey) {
    pendingKeys.set(storageKey, key)
    storeKey(storageKey, key)
  }
  return { userId, amount: normalizedAmount, key, storageKey, outcomeUncertain }
}

/** Release the registration key after receiving a definitive result. */
export function completeAffiliateWithdrawOperation(operation: AffiliateWithdrawOperation) {
  if (!operation.storageKey) return
  pendingKeys.delete(operation.storageKey)
  storeKey(operation.storageKey, null)
}
