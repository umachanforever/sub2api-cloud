import { describe, expect, it } from 'vitest'
import { planValiditySuffix } from '../validity'

const t = (key: string): string =>
  ({
    'payment.perMonth': '月',
    'payment.days': '天',
    'payment.weeks': '周',
    'payment.months': '个月',
  })[key] ?? key

const suffix = (validity_days: number, validity_unit: string) =>
  planValiditySuffix({ validity_days, validity_unit }, t)

describe('planValiditySuffix', () => {
  // #4607: The admin form saves the plural 'months'; previously, the user UI matched only the singular 'month',
  // causing a "1 month" plan to display as "1 day".
  it('renders admin-form plural months correctly', () => {
    expect(suffix(1, 'months')).toBe('月')
    expect(suffix(3, 'months')).toBe('3个月')
  })

  it('renders singular month the same way', () => {
    expect(suffix(1, 'month')).toBe('月')
    expect(suffix(6, 'month')).toBe('6个月')
  })

  // Billing converts weeks to days using ×7; the display must show weeks rather than days.
  it('renders weeks as weeks instead of mislabeled days', () => {
    expect(suffix(2, 'weeks')).toBe('2周')
    expect(suffix(1, 'week')).toBe('1周')
  })

  it('renders day-based and legacy units as days', () => {
    expect(suffix(30, 'days')).toBe('30天')
    expect(suffix(30, 'day')).toBe('30天') // Database default value
    expect(suffix(30, '')).toBe('30天')
  })

  // Backend psComputeValidityDays bills all unknown units as days; keep the display consistent
  // to avoid misleading cases such as "displayed as 1 year, actually 1 day".
  it('falls back to days for units billing does not honor', () => {
    expect(suffix(1, 'year')).toBe('1天')
    expect(suffix(365, 'unknown')).toBe('365天')
  })

  it('normalizes casing and whitespace', () => {
    expect(suffix(1, ' Months ')).toBe('月')
    expect(suffix(2, 'WEEKS')).toBe('2周')
  })
})
