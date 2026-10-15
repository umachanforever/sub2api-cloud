import type { RechargeBonusTier } from '@/types/payment'

export type { RechargeBonusTier }

export type RechargeBonusMode = 'bonus' | 'discount'

export const MAX_RECHARGE_BONUS_TIERS = 20
export const MAX_RECHARGE_BONUS_PERCENT = 1000

const AMOUNT_EPSILON = 1e-9

// Admin edit mode: both values may be empty (incomplete rows are discarded on submission).
export interface RechargeBonusTierDraft {
  min_amount: number | null
  bonus_percent: number | null
}

export interface RechargeBonusInterval {
  from: number
  /** null indicates an open-ended interval (≥ from) */
  to: number | null
  percent: number
}

export interface RechargeBonusQuote {
  mode: RechargeBonusMode
  /** Percentage of the matched tier; 0 if no tier matched or no discount was applied */
  percent: number
  /** Gateway payment base (payment currency, excluding fees); bonus mode = input amount, discount mode = discounted amount */
  payBase: number
  /** Credited base (input amount × multiplier, USD), excluding bonus */
  base: number
  /** Free credit (USD): extra credit in bonus mode; credited but unpaid portion in discount mode */
  bonus: number
  /** Total credited amount (USD) */
  credited: number
  tier: RechargeBonusTier | null
}

export function roundRechargeAmount(value: number, digits = 2): number {
  if (!Number.isFinite(value)) return 0
  const factor = 10 ** digits
  return Math.round((value + Number.EPSILON) * factor) / factor
}

function hasAtMostTwoDecimals(value: number): boolean {
  return Math.abs(roundRechargeAmount(value) - value) < AMOUNT_EPSILON
}

export function normalizeRechargeBonusMode(raw: unknown): RechargeBonusMode {
  return String(raw ?? '').trim().toLowerCase() === 'discount' ? 'discount' : 'bonus'
}

export function isRechargeBonusMinAmountValid(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && hasAtMostTwoDecimals(value)
}

export function isRechargeBonusPercentValid(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= MAX_RECHARGE_BONUS_PERCENT &&
    hasAtMostTwoDecimals(value)
  )
}

// In discount mode, the percentage must be < 100; otherwise the amount paid is zero or negative. Consistent with backend ValidateRechargeBonusTiersForMode.
export function isRechargeBonusPercentValidForMode(value: unknown, mode: RechargeBonusMode): value is number {
  if (!isRechargeBonusPercentValid(value)) return false
  return mode !== 'discount' || value < 100
}

function minAmountKey(value: number): string {
  return roundRechargeAmount(value).toFixed(2)
}

function collectTiers(candidates: { min_amount: unknown; bonus_percent: unknown }[]): RechargeBonusTier[] {
  const seen = new Set<string>()
  const out: RechargeBonusTier[] = []
  for (const item of candidates) {
    const minAmount = item.min_amount
    const percent = item.bonus_percent
    if (!isRechargeBonusMinAmountValid(minAmount) || !isRechargeBonusPercentValid(percent)) continue
    const key = minAmountKey(minAmount)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ min_amount: minAmount, bonus_percent: percent })
  }
  out.sort((a, b) => a.min_amount - b.min_amount)
  return out
}

// Lenient read-path normalization (checkout-info / admin GET population): discard invalid rows, keep the first duplicate threshold, and sort by threshold ascending.
export function normalizeRechargeBonusTiers(raw: unknown): RechargeBonusTier[] {
  if (!Array.isArray(raw)) return []
  const candidates: { min_amount: unknown; bonus_percent: unknown }[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const record = item as { min_amount?: unknown; bonus_percent?: unknown }
    candidates.push({
      min_amount: record.min_amount === null || record.min_amount === undefined || record.min_amount === '' ? NaN : Number(record.min_amount),
      bonus_percent: record.bonus_percent === null || record.bonus_percent === undefined || record.bonus_percent === '' ? NaN : Number(record.bonus_percent),
    })
  }
  return collectTiers(candidates)
}

// Submission cleanup: discard entire empty/invalid rows, keep the first duplicate threshold, and sort by threshold ascending.
export function sanitizeRechargeBonusTiersForSubmit(
  tiers: RechargeBonusTierDraft[] | null | undefined,
): RechargeBonusTier[] {
  if (!Array.isArray(tiers)) return []
  return collectTiers(
    tiers.map((tier) => ({
      min_amount: tier?.min_amount === null || tier?.min_amount === undefined ? NaN : Number(tier.min_amount),
      bonus_percent: tier?.bonus_percent === null || tier?.bonus_percent === undefined ? NaN : Number(tier.bonus_percent),
    })),
  )
}

// Immediate editor validation: return true if the same threshold already appears in another row.
export function isDuplicateRechargeBonusMinAmount(tiers: RechargeBonusTierDraft[], index: number): boolean {
  const current = tiers[index]?.min_amount
  if (!isRechargeBonusMinAmountValid(current)) return false
  const key = minAmountKey(current)
  return tiers.some((tier, i) => i !== index && isRechargeBonusMinAmountValid(tier.min_amount) && minAmountKey(tier.min_amount) === key)
}

// Match rule: select the highest threshold not exceeding the payment amount; consistent with backend matchRechargeBonusTier.
export function matchRechargeBonusTier(tiers: RechargeBonusTier[], paymentAmount: number): RechargeBonusTier | null {
  if (!Number.isFinite(paymentAmount) || paymentAmount <= 0) return null
  let matched: RechargeBonusTier | null = null
  for (const tier of tiers) {
    if (paymentAmount + AMOUNT_EPSILON < tier.min_amount) continue
    if (!matched || tier.min_amount > matched.min_amount) matched = tier
  }
  return matched
}

// Bonus credit = credited base × percentage, rounded to two decimal places; consistent with backend calculateRechargeBonus.
export function calculateRechargeBonus(baseCredited: number, percent: number): number {
  if (!Number.isFinite(baseCredited) || !Number.isFinite(percent) || baseCredited <= 0 || percent <= 0) return 0
  return roundRechargeAmount((baseCredited * percent) / 100)
}

export interface RechargeBonusQuoteOptions {
  multiplier?: number
  mode?: RechargeBonusMode
  /** Decimal places for the payment currency; the payment base in discount mode is rounded to this precision */
  currencyDigits?: number
}

// Recharge page quote: compare thresholds against payment amount; add the bonus to the credited base in bonus mode, or reduce the payment by the percentage in discount mode.
// Consistent with backend quoteRechargeBonus (including the fail-safe for discounts ≥ 100%).
export function quoteRechargeBonus(
  tiers: RechargeBonusTier[],
  paymentAmount: number,
  options: RechargeBonusQuoteOptions | number = {},
): RechargeBonusQuote {
  const opts: RechargeBonusQuoteOptions = typeof options === 'number' ? { multiplier: options } : options
  const mode = opts.mode ?? 'bonus'
  const amount = Number.isFinite(paymentAmount) && paymentAmount > 0 ? paymentAmount : 0
  const rate = typeof opts.multiplier === 'number' && Number.isFinite(opts.multiplier) && opts.multiplier > 0 ? opts.multiplier : 1
  const digits = typeof opts.currencyDigits === 'number' && Number.isInteger(opts.currencyDigits) && opts.currencyDigits >= 0 ? opts.currencyDigits : 2
  const base = roundRechargeAmount(amount * rate)
  const quote: RechargeBonusQuote = { mode, percent: 0, payBase: amount, base, bonus: 0, credited: base, tier: null }
  const tier = matchRechargeBonusTier(tiers, amount)
  if (!tier || tier.bonus_percent <= 0) return quote
  quote.tier = tier
  if (mode === 'discount') {
    if (tier.bonus_percent >= 100) return quote
    const payBase = roundRechargeAmount((amount * (100 - tier.bonus_percent)) / 100, digits)
    if (payBase <= 0 || payBase >= amount) return quote
    const paidCredit = roundRechargeAmount(payBase * rate)
    quote.payBase = payBase
    quote.bonus = Math.max(0, roundRechargeAmount(base - paidCredit))
    quote.percent = tier.bonus_percent
    return quote
  }
  const bonus = calculateRechargeBonus(base, tier.bonus_percent)
  if (bonus <= 0) return quote
  quote.bonus = bonus
  quote.credited = roundRechargeAmount(base + bonus)
  quote.percent = tier.bonus_percent
  return quote
}

// Interval preview: expand the ascending threshold list into [from, to) intervals; prepend a "No discount" interval when the first threshold is > 0.
export function describeRechargeBonusIntervals(tiers: RechargeBonusTier[]): RechargeBonusInterval[] {
  const sorted = [...tiers].sort((a, b) => a.min_amount - b.min_amount)
  const out: RechargeBonusInterval[] = []
  if (sorted.length === 0) return out
  if (sorted[0]!.min_amount > 0) {
    out.push({ from: 0, to: sorted[0]!.min_amount, percent: 0 })
  }
  sorted.forEach((tier, index) => {
    out.push({ from: tier.min_amount, to: sorted[index + 1]?.min_amount ?? null, percent: tier.bonus_percent })
  })
  return out
}

// For display: trim redundant decimal zeros (20 → "20", 12.5 → "12.5").
export function formatRechargeBonusNumber(value: number): string {
  if (!Number.isFinite(value)) return '0'
  return String(Number(value.toFixed(2)))
}
