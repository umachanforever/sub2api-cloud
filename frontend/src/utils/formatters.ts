/**
 * Format cached token count (1K/1M abbreviations)
 */
export function formatCacheTokens(tokens: number): string {
  if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(1)}M`
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}K`
  return tokens.toLocaleString()
}

/**
 * Format a multiplier with adaptive precision: keep up to 4 decimal places and trim trailing zeros,
 * but keep at least 2 decimal places (0.035 -> "0.035", 0.3 -> "0.30", 1 -> "1.00")
 */
export function formatMultiplier(val: number): string {
  if (val < 0.0001) return val.toPrecision(2)
  return val.toFixed(4).replace(/(\.\d{2}\d*?)0+$/, '$1')
}
