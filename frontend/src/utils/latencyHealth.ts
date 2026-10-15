import type { UsageLog } from '@/types'

/**
 * Request latency health tiers (for vertically scanning health in the usage details "Latency" column).
 *
 * Time to first token (TTFT): normal within 10s, slightly slow at 10-30s, slow at 30-60s, critical at 60s or more.
 * Total duration: streaming requests are naturally longer overall, so thresholds are relaxed to 1min / 3min / 5min.
 */
export type LatencySeverity = 'good' | 'warn' | 'slow' | 'critical'

export const FIRST_TOKEN_THRESHOLDS_MS = {
  warn: 10_000,
  slow: 30_000,
  critical: 60_000,
} as const

export const DURATION_THRESHOLDS_MS = {
  warn: 60_000,
  slow: 180_000,
  critical: 300_000,
} as const

interface Thresholds {
  warn: number
  slow: number
  critical: number
}

const classify = (ms: number, thresholds: Thresholds): LatencySeverity => {
  if (ms >= thresholds.critical) return 'critical'
  if (ms >= thresholds.slow) return 'slow'
  if (ms >= thresholds.warn) return 'warn'
  return 'good'
}

export const firstTokenSeverity = (ms: number): LatencySeverity =>
  classify(ms, FIRST_TOKEN_THRESHOLDS_MS)

export const durationSeverity = (ms: number): LatencySeverity =>
  classify(ms, DURATION_THRESHOLDS_MS)

export const LATENCY_TEXT_CLASSES: Record<LatencySeverity, string> = {
  good: 'text-emerald-600 dark:text-emerald-400',
  warn: 'text-amber-600 dark:text-amber-400',
  slow: 'text-orange-600 dark:text-orange-400',
  critical: 'text-red-600 dark:text-red-400',
}

/** Solid-color bar when no time-to-first-byte data is available (colored only by total-duration tier). */
export const LATENCY_BAR_CLASSES: Record<LatencySeverity, string> = {
  good: 'bg-emerald-500',
  warn: 'bg-amber-400',
  slow: 'bg-orange-500',
  critical: 'bg-red-500',
}

/** Top of the gradient bar (time-to-first-byte tier); combines with LATENCY_BAR_TO_CLASSES into a vertical gradient to avoid a harsh split. */
export const LATENCY_BAR_FROM_CLASSES: Record<LatencySeverity, string> = {
  good: 'from-emerald-500',
  warn: 'from-amber-400',
  slow: 'from-orange-500',
  critical: 'from-red-500',
}

/** Bottom of the gradient bar (total-duration tier). */
export const LATENCY_BAR_TO_CLASSES: Record<LatencySeverity, string> = {
  good: 'to-emerald-500',
  warn: 'to-amber-400',
  slow: 'to-orange-500',
  critical: 'to-red-500',
}

// Consistent with Ops Token request statistics: use full duration; output may include reasoning Tokens.
export const formatUsageOutputRate = (row: Pick<UsageLog,
  'output_tokens' | 'duration_ms' | 'image_count' | 'image_output_tokens' | 'billing_mode' | 'request_type'
>): string => {
  const { output_tokens: outputTokens, duration_ms: durationMs } = row
  if (row.image_count > 0 || row.image_output_tokens > 0 || row.billing_mode === 'image'
    || (row.request_type && !['sync', 'stream', 'ws_v2', 'cyber'].includes(row.request_type))
    || !Number.isFinite(outputTokens) || outputTokens <= 0
    || durationMs == null || !Number.isFinite(durationMs) || durationMs <= 0) {
    return '—'
  }
  return `${(outputTokens * 1000 / durationMs).toFixed(1)} tok/s`
}
