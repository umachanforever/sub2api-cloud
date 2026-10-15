/**
 * Model Plaza API (public endpoint, anonymously accessible)
 * Group-centric model pricing: group information + model channel pricing + official LiteLLM reference prices.
 * When a token is provided, the backend additionally returns exclusive groups and the user's exclusive multiplier.
 */

import { apiClient } from './client'
import type { UserPricingInterval, UserSupportedModelPricing } from './channels'

/** Official reference price (USD per token, from the same source as the billing catalog; missing field = not covered by the catalog). */
export interface PlazaOfficialPricing {
  input_price: number | null
  output_price: number | null
  /** 5m cache write (= LiteLLM cache_creation). */
  cache_write_price: number | null
  /** 1h cache write (LiteLLM cache_creation_above_1hr); missing for most models. */
  cache_write_1h_price?: number | null
  cache_read_price: number | null
  /** Official long-context tiers (available only for multi-tier models); unaffected by group switches. */
  intervals?: UserPricingInterval[]
}

/**
 * Pricing basis for multiple tiers:
 * - whole_request: charge the entire request at the unit price of its tier (catalog tiers, channel ranges);
 * - marginal: charge only the portion exceeding the threshold at the tier's unit price (legacy platform rule).
 */
export type PlazaLongContextBasis = 'whole_request' | 'marginal'

/** Time-based multiplier period: within [start_time, end_time) on the configured timezone's current day, multiply the total payment by multiplier. */
export interface PlazaTimePricingPeriod {
  start_time: string
  end_time: string
  multiplier: number
}

/** Time-based multipliers that affect billing (only periods with multiplier ≠ 1, sorted by start time). */
export interface PlazaTimePricing {
  /** IANA timezone name, such as Asia/Shanghai. */
  timezone: string
  /** When true, the period applies only Monday through Friday; weekends are billed at the standard price all day. */
  weekdays_only?: boolean
  periods: PlazaTimePricingPeriod[]
}

export interface PlazaModel {
  name: string
  platform: string
  /** Display pricing based on the actual charge: a tier may provide an absolute unit price or a multiplier relative to the base price; all are standard-period prices. */
  pricing: UserSupportedModelPricing | null
  official_pricing: PlazaOfficialPricing | null
  /** Returned only for multi-tier models. */
  long_context_basis?: PlazaLongContextBasis
  /** Returned only for models configured with time-based multipliers. */
  time_pricing?: PlazaTimePricing
}

export interface ModelPlazaGroup {
  id: number
  name: string
  description: string
  platform: string
  /** 'standard' | 'subscription' */
  subscription_type: string
  rate_multiplier: number
  /** Returned when logged in and the administrator configured an exclusive multiplier for the user; effective multiplier = user_rate ?? rate_multiplier. */
  user_rate_multiplier?: number
  peak_rate_enabled: boolean
  peak_start: string
  peak_end: string
  peak_rate_multiplier: number
  is_exclusive: boolean
  /** Independent image-generation multiplier: when true, the actual multiplier for image-billing models uses image_rate_multiplier instead of the group/exclusive multiplier. */
  image_rate_independent: boolean
  image_rate_multiplier: number
  /** When the independent video multiplier is enabled, it overrides the group/user-exclusive multiplier for video models. */
  video_rate_independent: boolean
  video_rate_multiplier: number
  /** Whether the group enables long-context tier billing; when false, the actual-charge column displays only the lowest tier, while official tiers are for reference only. */
  long_context_pricing_enabled: boolean
  models: PlazaModel[]
}

export interface ModelPlazaResponse {
  /** Global price description configured by the administrator (Markdown). */
  description: string
  groups: ModelPlazaGroup[]
}

/** Fetch Model Plaza data. The backend returns 404 when the feature is disabled. */
export async function getModelPlaza(options?: { signal?: AbortSignal }): Promise<ModelPlazaResponse> {
  const { data } = await apiClient.get<ModelPlazaResponse>('/model-plaza', {
    signal: options?.signal
  })
  return data
}

export const modelPlazaAPI = { getModelPlaza }

export default modelPlazaAPI
