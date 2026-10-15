/**
 * Error request "category" virtual dimension: phase + error type → coarse user-facing category code.
 * Mirrors backend service.MapUserErrorCategory(backend/internal/service/ops_user_error.go);
 * changes in both places must stay synchronized. Returns a stable category code; display text uses i18n `usage.errors.categories.*`.
 */
export function mapErrorCategory(phase?: string | null, errType?: string | null): string {
  switch ((phase || '').toLowerCase()) {
    case 'auth':
      return 'auth'
    case 'routing':
      return 'service_unavailable'
    case 'account_auth':
    case 'upstream':
    case 'network':
      return 'upstream'
    case 'internal':
      return 'internal'
    case 'request':
      switch ((errType || '').toLowerCase()) {
        case 'rate_limit_error':
          return 'rate_limit'
        case 'billing_error':
        case 'subscription_error':
          return 'quota'
        case 'invalid_request_error':
          return 'invalid_request'
        case 'cyber_policy':
          return 'cyber'
      }
  }
  return 'other'
}
