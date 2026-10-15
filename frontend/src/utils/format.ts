/**
 * Formatting utilities
 * Based on the format.js implementation from the CRS project
 */

import { i18n, getLocale } from '@/i18n'

/**
 * Format relative time
 * @param date Date string or Date object
 * @returns Relative time string, such as "5m ago", "2h ago", "3d ago"
 */
export function formatRelativeTime(date: string | Date | null | undefined): string {
  if (!date) return i18n.global.t('common.time.never')

  const now = new Date()
  const past = new Date(date)
  const diffMs = now.getTime() - past.getTime()

  // Handle future times or invalid dates
  if (diffMs < 0 || isNaN(diffMs)) return i18n.global.t('common.time.never')

  const diffSecs = Math.floor(diffMs / 1000)
  const diffMins = Math.floor(diffSecs / 60)
  const diffHours = Math.floor(diffMins / 60)
  const diffDays = Math.floor(diffHours / 24)

  if (diffDays > 0) return i18n.global.t('common.time.daysAgo', { n: diffDays })
  if (diffHours > 0) return i18n.global.t('common.time.hoursAgo', { n: diffHours })
  if (diffMins > 0) return i18n.global.t('common.time.minutesAgo', { n: diffMins })
  return i18n.global.t('common.time.justNow')
}

/**
 * Format a number with K/M/B units
 * @param num Number
 * @returns Formatted string, such as "1.2K", "3.5M"
 */
export function formatNumber(num: number | null | undefined): string {
  if (num === null || num === undefined) return '0'

  const locale = getLocale()
  const absNum = Math.abs(num)

  // Use Intl.NumberFormat for compact notation if supported and needed
  // Note: Compact notation in 'zh' uses ten-thousand/hundred-million units, which is appropriate for Chinese
  const formatter = new Intl.NumberFormat(locale, {
    notation: absNum >= 10000 ? 'compact' : 'standard',
    maximumFractionDigits: 1
  })

  return formatter.format(num)
}

/**
 * Format a currency amount
 * @param amount Amount
 * @param currency Currency code; defaults to USD
 * @returns Formatted string, such as "$1.25"
 */
export function formatCurrency(amount: number | null | undefined, currency: string = 'USD'): string {
  if (amount === null || amount === undefined) return '$0.00'

  const locale = getLocale()

  // For very small amounts, show more decimals
  const fractionDigits = amount > 0 && amount < 0.01 ? 6 : 2

  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: currency,
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits
  }).format(amount)
}

/**
 * Format a byte size
 * @param bytes Number of bytes
 * @param decimals Number of decimal places
 * @returns Formatted string, such as "1.5 MB"
 */
export function formatBytes(bytes: number, decimals: number = 2): string {
  if (bytes === 0) return '0 Bytes'

  const k = 1024
  const dm = decimals < 0 ? 0 : decimals
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB']

  const i = Math.max(0, Math.floor(Math.log(bytes) / Math.log(k)))

  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i]
}

/**
 * Format a date
 * @param date Date string or Date object
 * @param options Intl.DateTimeFormatOptions
 * @param localeOverride Optional locale override
 * @returns Formatted date string
 */
export function formatDate(
  date: string | Date | null | undefined,
  options: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  },
  localeOverride?: string
): string {
  if (!date) return ''

  const d = new Date(date)
  if (isNaN(d.getTime())) return ''

  const locale = localeOverride ?? getLocale()
  return new Intl.DateTimeFormat(locale, options).format(d)
}

/**
 * Format a date (date part only)
 * @param date Date string or Date object
 * @returns Formatted date string
 */
export function formatDateOnly(date: string | Date | null | undefined): string {
  return formatDate(date, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  })
}

/**
 * Format a date and time (full format)
 * @param date Date string or Date object
 * @param options Intl.DateTimeFormatOptions
 * @param localeOverride Optional locale override
 * @returns Formatted date-time string
 */
export function formatDateTime(
  date: string | Date | null | undefined,
  options?: Intl.DateTimeFormatOptions,
  localeOverride?: string
): string {
  return formatDate(date, options, localeOverride)
}

/**
 * Format a date and time to minute precision
 */
export function formatDateTimeToMinute(
  date: string | Date | null | undefined,
  localeOverride?: string
): string {
  return formatDate(
    date,
    {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    },
    localeOverride
  )
}

/**
 * Format as a date input value (YYYY-MM-DD, using local time)
 */
export function formatDateLocalInput(date: Date): string {
  if (isNaN(date.getTime())) return ''
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * Format as a datetime-local input value (YYYY-MM-DDTHH:mm, using local time)
 */
export function formatDateTimeLocalInput(timestampSeconds: number | null): string {
  if (!timestampSeconds) return ''
  const date = new Date(timestampSeconds * 1000)
  if (isNaN(date.getTime())) return ''
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${year}-${month}-${day}T${hours}:${minutes}`
}

/**
 * Parse a datetime-local input value into a timestamp (seconds, using local time)
 */
export function parseDateTimeLocalInput(value: string): number | null {
  if (!value) return null

  // datetime-local intentionally has no timezone. Parse its components explicitly
  // so malformed values or timezone-bearing strings are not reinterpreted by Date.parse.
  const match = /^(\d{4,})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?$/.exec(value)
  if (!match) return null

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hours = Number(match[4])
  const minutes = Number(match[5])
  const seconds = match[6] ? Number(match[6]) : 0
  const milliseconds = match[7]
    ? Number(match[7].slice(0, 3).padEnd(3, '0'))
    : 0

  if (
    !Number.isSafeInteger(year) ||
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hours > 23 ||
    minutes > 59 ||
    seconds > 59
  ) {
    return null
  }

  const date = new Date(0)
  date.setFullYear(year, month - 1, day)
  date.setHours(hours, minutes, seconds, milliseconds)

  // Date setters normalize calendar overflows (for example, February 30). Keep
  // the platform's existing DST disambiguation for otherwise valid local times.
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null
  }

  const timestamp = date.getTime()
  return Number.isFinite(timestamp) ? Math.floor(timestamp / 1000) : null
}

/**
 * Get the browser's current IANA time zone
 */
export function getBrowserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/**
 * Format OpenAI reasoning effort for usage record display
 * @param effort Raw effort value, such as "low" / "medium" / "high" / "xhigh"
 * @returns Formatted string (Low / Medium / High / Xhigh), or "-" if empty
 */
function normalizeReasoningEffortKey(effort: string | null | undefined): string {
  return (effort ?? '').toString().trim().toLowerCase().replace(/[-_\s]/g, '')
}

export function formatReasoningEffort(effort: string | null | undefined): string {
  const raw = (effort ?? '').toString().trim()
  if (!raw) return '-'

  const normalized = normalizeReasoningEffortKey(raw)
  switch (normalized) {
    case 'low':
      return 'Low'
    case 'medium':
      return 'Medium'
    case 'high':
      return 'High'
    case 'xhigh':
    case 'extrahigh':
      return 'XHigh'
    case 'max':
      return 'Max'
    case 'none':
    case 'minimal':
      return '-'
    default:
      // best-effort: Title-case first letter
      return raw.length > 1 ? raw[0].toUpperCase() + raw.slice(1) : raw.toUpperCase()
  }
}

export function reasoningEffortValuesEqual(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  const a = normalizeReasoningEffortKey(left)
  const b = normalizeReasoningEffortKey(right)
  if (!a && !b) return true
  return a !== '' && a === b
}

/** Requested vs forwarded effort for usage export; one value when they match. */
export function formatReasoningEffortMapping(
  requested: string | null | undefined,
  forwarded: string | null | undefined,
): string {
  const requestedLabel = formatReasoningEffort(requested)
  const forwardedLabel = formatReasoningEffort(forwarded)
  if (requestedLabel === '-' && forwardedLabel === '-') return '-'
  if (requestedLabel === '-' || reasoningEffortValuesEqual(requested, forwarded)) {
    return forwardedLabel === '-' ? requestedLabel : forwardedLabel
  }
  if (forwardedLabel === '-') return requestedLabel
  return `${requestedLabel} → ${forwardedLabel}`
}

/**
 * Format a time (hours, minutes, and seconds)
 * @param date Date string or Date object
 * @returns Formatted time string
 */
export function formatTime(date: string | Date | null | undefined): string {
  return formatDate(date, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  })
}

/**
 * Format a number with thousands separators, without compact units
 * @param num Number
 * @returns Formatted string, e.g. "12,345"
 */
export function formatNumberLocaleString(num: number): string {
  if (num == null) return '未知'
  return num.toLocaleString()
}

/**
 * Format an amount with fixed decimal places and no currency symbol
 * @param amount Amount
 * @param fractionDigits Number of decimal places, defaults to 4
 * @returns Formatted string, e.g. "1.2345"
 */
export function formatCostFixed(amount: number, fractionDigits: number = 4): string {
  if (amount == null) return '未提供'
  return amount.toFixed(fractionDigits)
}

/**
 * Format a token count (>=1M as M, >=1K as K, with 1 decimal place)
 * @param tokens Token count
 * @returns Formatted string, e.g. "950", "1.2K", "3.5M"
 */
export function formatTokensK(tokens: number): string {
  if (tokens == null) return '未知'
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}K`
  return tokens.toString()
}

/**
 * Format a large number (K/M/B, with 1 decimal place)
 * @param num Number
 * @param options When allowBillions=false, use at most M
 */
export function formatCompactNumber(
  num: number | null | undefined,
  options?: { allowBillions?: boolean }
): string {
  if (num === null || num === undefined) return '0'

  const abs = Math.abs(num)
  const allowBillions = options?.allowBillions !== false

  if (allowBillions && abs >= 1_000_000_000) return `${(num / 1_000_000_000).toFixed(1)}B`
  if (abs >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`
  if (abs >= 1_000) return `${(num / 1_000).toFixed(1)}K`
  return num.toString()
}

/**
 * Format a countdown (time remaining from now until the target time)
 * @param targetDate Target date string or Date object
 * @returns Countdown string, e.g. "2h 41m", "3d 5h", "15m"
 */
export function formatCountdown(targetDate: string | Date | null | undefined): string | null {
  if (!targetDate) return null

  const now = new Date()
  const target = new Date(targetDate)
  const diffMs = target.getTime() - now.getTime()

  // If the target time has passed or is invalid
  if (diffMs <= 0 || isNaN(diffMs)) return null

  const diffMins = Math.floor(diffMs / (1000 * 60))
  const diffHours = Math.floor(diffMins / 60)
  const diffDays = Math.floor(diffHours / 24)

  const remainingHours = diffHours % 24
  const remainingMins = diffMins % 60

  if (diffDays > 0) {
    // Over 1 day: display "Xd Yh"
    return i18n.global.t('common.time.countdown.daysHours', { d: diffDays, h: remainingHours })
  }
  if (diffHours > 0) {
    // Under 1 day: display "Xh Ym"
    return i18n.global.t('common.time.countdown.hoursMinutes', { h: diffHours, m: remainingMins })
  }
  // Under 1 hour: display "Ym"
  return i18n.global.t('common.time.countdown.minutes', { m: diffMins })
}

/**
 * Format a countdown with a suffix (e.g. "lifted after 2h 41m")
 * @param targetDate Target date string or Date object
 * @returns Complete countdown string, e.g. "2h 41m to lift", "lifted after 2 hours 41 minutes"
 */
export function formatCountdownWithSuffix(targetDate: string | Date | null | undefined): string | null {
  const countdown = formatCountdown(targetDate)
  if (!countdown) return null
  return i18n.global.t('common.time.countdown.withSuffix', { time: countdown })
}

/**
 * Format as a combination of relative and exact time
 * @param date Date string or Date object
 * @returns Combined time string, e.g. "5 days ago · 2026-01-27 15:25"
 */
export function formatRelativeWithDateTime(date: string | Date | null | undefined): string {
  if (!date) return ''

  const relativeTime = formatRelativeTime(date)
  const dateTime = formatDateTime(date)

  // If it is "Never" or an empty string, return only the relative time
  if (!dateTime || relativeTime === i18n.global.t('common.time.never')) {
    return relativeTime
  }

  return `${relativeTime} · ${dateTime}`
}
