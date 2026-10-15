/**
 * Shared badge colors and column mappings for error requests/usage details.
 * Uses the bg-X-100/text-X-800 color system consistently with UsageTable.
 */

import type { UsageRequestType } from '@/types'

export type UsageRequestKind = UsageRequestType

/** Status code badges: ≥500 red, 429 purple, ≥400 amber, otherwise gray */
export function statusCodeBadgeClass(code: number): string {
  if (code >= 500) return 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200'
  if (code === 429) return 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200'
  if (code >= 400) return 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200'
  return 'bg-gray-100 text-gray-800 dark:bg-dark-700 dark:text-gray-200'
}

/** Request type badge colors (cyber red, live green, ws purple, stream blue, sync gray, unknown amber) */
export function requestTypeBadgeClass(kind: UsageRequestKind): string {
  if (kind === 'cyber') return 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200'
  if (kind === 'live') return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200'
  if (kind === 'ws_v2') return 'bg-violet-100 text-violet-800 dark:bg-violet-900 dark:text-violet-200'
  if (kind === 'stream') return 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200'
  if (kind === 'sync') return 'bg-gray-100 text-gray-800 dark:bg-dark-700 dark:text-gray-200'
  return 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200'
}

/** Request type i18n keys (the renderer calls t()) */
export function requestTypeLabelKey(kind: UsageRequestKind): string {
  if (kind === 'cyber') return 'usage.cyber'
  if (kind === 'live') return 'usage.live'
  if (kind === 'ws_v2') return 'usage.ws'
  if (kind === 'stream') return 'usage.stream'
  if (kind === 'sync') return 'usage.sync'
  return 'usage.unknown'
}

/**
 * Numeric request_type (1 sync/2 stream/3 WS) → kind;
 * if missing, fall back to the stream boolean; return null if both are missing (displayed as -).
 */
export function numericRequestTypeKind(
  requestType?: number | null,
  stream?: boolean | null
): UsageRequestKind | null {
  const rt = requestType ?? (stream == null ? 0 : stream ? 2 : 1)
  if (rt === 3) return 'ws_v2'
  if (rt === 5) return 'live'
  if (rt === 2) return 'stream'
  if (rt === 1) return 'sync'
  return null
}

/** Error table column key → backend sort_by (the status column is actually sorted by status_code) */
export function mapErrorSortKey(key: string): string {
  return key === 'status' ? 'status_code' : key
}

/**
 * Fixed common status code options for error request filters (shared by admin + user views).
 * Use a fixed list instead of deriving it from "codes appearing on the current page" to avoid making a target status code unavailable when it appears only on later pages/outside the current filter
 * —backend status_code filtering applies to the full dataset, so options should not be limited by current-page data.
 */
export const COMMON_ERROR_STATUS_CODES = [400, 401, 403, 404, 408, 413, 429, 499, 500, 502, 503, 504, 529]
