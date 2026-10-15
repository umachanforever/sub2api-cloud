// Proxy expiration display logic (shared by ProxiesView and AccountsView).
// Two fixed expiration urgency tiers: red for ≤3 days remaining and yellow for ≤7 days (ignore per-proxy expiry_warn_days).
export const EXPIRY_WARN_DAYS = 7
export const EXPIRY_DANGER_DAYS = 3

// Whole days remaining (rounded up).
export const daysUntil = (iso: string): number =>
  Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000)

// CSS class for the countdown badge (pure function, no i18n dependency).
export function proxyExpiryBadgeClass(expiresAt: string | null, status?: string): string {
  if (status === 'expired') return 'badge badge-danger'
  const d = expiresAt ? daysUntil(expiresAt) : Infinity
  if (d <= EXPIRY_DANGER_DAYS) return 'badge badge-danger'
  if (d <= EXPIRY_WARN_DAYS) return 'badge badge-warning'
  return 'text-gray-500'
}

// i18n key and arguments for countdown text (return the key rather than translated text for easier unit testing and no i18n coupling).
export function proxyExpiryLabelKey(
  expiresAt: string | null,
  status?: string,
): { key: string; params?: { days: number } } {
  if (status === 'expired') return { key: 'admin.proxies.expired' }
  const d = expiresAt ? daysUntil(expiresAt) : Infinity
  if (d === 0) return { key: 'admin.proxies.expired' }
  if (d < 0) return { key: 'admin.proxies.overdueDays', params: { days: Math.abs(d) } }
  if (d <= EXPIRY_WARN_DAYS) return { key: 'admin.proxies.expiringInDays', params: { days: d } }
  return { key: 'admin.proxies.remainingDays', params: { days: d } }
}
