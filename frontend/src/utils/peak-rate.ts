/**
 * Shared display logic for peak-hour multipliers.
 *
 * The backend determines the peak window using the server's global timezone (Group.PeakMultiplierAt).
 * The frontend must display the server timezone label (from the public setting server_utc_offset)
 * to prevent users from interpreting the billing window in their browser's local time.
 */

export interface PeakRateFields {
  peak_rate_enabled?: boolean
  peak_start?: string
  peak_end?: string
  peak_rate_multiplier?: number
}

export function hasPeakRate(fields?: PeakRateFields | null): boolean {
  return Boolean(fields?.peak_rate_enabled && fields.peak_start && fields.peak_end)
}

/** "+08:00" → "UTC+08:00"; return an empty string when this field is absent from legacy caches, allowing callers to omit the timezone label */
export function serverTimezoneLabel(utcOffset?: string | null): string {
  return utcOffset ? `UTC${utcOffset}` : ''
}

/** "14:00-18:00 ×2 (UTC+08:00)"; omit the parenthesized part when tzLabel is empty */
export function formatPeakRateWindow(
  fields: PeakRateFields | null | undefined,
  tzLabel?: string
): string {
  if (!hasPeakRate(fields) || !fields) return ''
  const base = `${fields.peak_start}-${fields.peak_end} ×${fields.peak_rate_multiplier ?? 1}`
  return tzLabel ? `${base} (${tzLabel})` : base
}
