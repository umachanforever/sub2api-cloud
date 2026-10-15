/**
 * Admin CN providers (Kimi / Zhipu / DeepSeek) API endpoints.
 * Coding-plan rolling-window quota probe + payg balance probe.
 */

import { apiClient } from '../client'

/** Rolling usage window tier (5 hours / weekly), aligned with backend service.CNQuotaTier. */
export interface CNQuotaTier {
  window: '5h' | 'weekly' | 'monthly'
  used_percent: number
  reset_at?: string
}

/** Credit detection result (Coding Plan / OpenCode Go / Command Code), aligned with backend CNProviderQuotaProbeResult. */
export interface CNProviderQuotaProbeResult {
  provider: string
  source?: string
  success: boolean
  credential_valid: boolean
  tiers?: CNQuotaTier[]
  plan_level?: string
  status_code?: number
  fetched_at: number
  persisted: boolean
  error?: string
  /** Balance obtained from the same probe (Command Code credits share the window source); empty for other providers. */
  balance?: CNProviderBalanceResult
}

/** Single-currency balance detail (deepseek dual-currency accounts contain one CNY and one USD entry). */
export interface CNProviderBalanceEntry {
  currency: string
  balance: number
}

/** payg balance probe result (kimi / deepseek), aligned with backend CNProviderBalanceResult. */
export interface CNProviderBalanceResult {
  provider: string
  success: boolean
  /** Primary-currency balance (first entry in balances, for single-currency display compatibility). */
  balance: number
  currency?: string
  /** Multi-currency details; displayed in the primary currency when absent. */
  balances?: CNProviderBalanceEntry[]
  available: boolean
  status_code?: number
  fetched_at: number
  persisted: boolean
  error?: string
}

/** Query Coding Plan rolling-window usage (5h + weekly). */
export async function queryQuota(id: number): Promise<CNProviderQuotaProbeResult> {
  const { data } = await apiClient.get<CNProviderQuotaProbeResult>(
    `/admin/cn-providers/accounts/${id}/quota`
  )
  return data
}

/** Query the payg account balance. */
export async function queryBalance(id: number): Promise<CNProviderBalanceResult> {
  const { data } = await apiClient.get<CNProviderBalanceResult>(
    `/admin/cn-providers/accounts/${id}/balance`
  )
  return data
}

export default {
  queryQuota,
  queryBalance
}
