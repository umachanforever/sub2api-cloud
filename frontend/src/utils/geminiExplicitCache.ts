const OFFICIAL_GEMINI_API_HOST = 'generativelanguage.googleapis.com'

/** Whether the Gemini API Key account's base_url is official; empty is treated as official. */
export function isOfficialGeminiBaseUrl(raw: string | null | undefined): boolean {
  const value = (raw ?? '').trim()
  if (!value) return true
  try {
    const url = new URL(value)
    const path = url.pathname.replace(/\/+$/, '')
    return (
      url.protocol === 'https:' &&
      url.hostname.toLowerCase() === OFFICIAL_GEMINI_API_HOST &&
      url.port === '' &&
      path === '' &&
      url.search === ''
    )
  } catch {
    return false
  }
}

/** Maximum upstream cache lifetime (seconds): non-positive or non-numeric values are treated as unset. */
export function normalizeExplicitCacheUpstreamMaxTTL(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const seconds = Number(value)
  return Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : null
}

/** Add the explicit upstream cache switch to account credentials, or remove it. */
export function applyExplicitCacheUpstreamCredentials(
  credentials: Record<string, unknown>,
  enabled: boolean,
  maxTTL: unknown
): void {
  if (!enabled) {
    delete credentials.explicit_cache_upstream
    delete credentials.explicit_cache_upstream_max_ttl_seconds
    return
  }
  credentials.explicit_cache_upstream = true
  const seconds = normalizeExplicitCacheUpstreamMaxTTL(maxTTL)
  if (seconds === null) {
    delete credentials.explicit_cache_upstream_max_ttl_seconds
  } else {
    credentials.explicit_cache_upstream_max_ttl_seconds = seconds
  }
}
