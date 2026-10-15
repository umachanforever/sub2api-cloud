import type { SubscriptionPlan } from '@/types/payment'

type TranslateFn = (key: string) => string

/**
 * User-facing plan validity suffix ("$9.9 / month", "$9.9 / 30 days").
 *
 * The admin form saves plural units (days/weeks/months), while the database default and some
 * historical data use the singular form (day). Backend billing via psComputeValidityDays converts week/weeks and
 * month/months to days using ×7 and ×30 respectively, and treats all other units as days. Previously, the user UI matched only
 * the singular 'month', so admin-saved 'months' always entered the default branch, causing a "1 month" plan
 * to display as "1 day" (#4607); 'weeks' would likewise display the number of weeks as "N days".
 *
 * Normalize units here and map them one-to-one to billing semantics, ensuring that the period users see matches the actual
 * effective period.
 */
export function planValiditySuffix(
  plan: Pick<SubscriptionPlan, 'validity_days' | 'validity_unit'>,
  t: TranslateFn,
): string {
  const unit = String(plan.validity_unit || 'day').trim().toLowerCase()
  const base = unit.endsWith('s') ? unit.slice(0, -1) : unit
  const days = plan.validity_days
  if (base === 'month') {
    return days === 1 ? t('payment.perMonth') : `${days}${t('payment.months')}`
  }
  if (base === 'week') {
    return `${days}${t('payment.weeks')}`
  }
  // The backend bills all other units (including the database default day and unknown values) as days; keep the display consistent.
  return `${days}${t('payment.days')}`
}
