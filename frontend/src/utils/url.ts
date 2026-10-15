/**
 * Validate and normalize a URL
 * By default, accept only absolute URLs starting with http:// or https://; relative paths may optionally be allowed
 * @param value User-entered URL
 * @returns Normalized URL, or an empty string if invalid
 */
type SanitizeOptions = {
  allowRelative?: boolean
  allowDataUrl?: boolean
}

export function sanitizeUrl(value: string, options: SanitizeOptions = {}): string {
  const trimmed = value.trim()
  if (!trimmed) {
    return ''
  }

  if (options.allowRelative && trimmed.startsWith('/') && !trimmed.startsWith('//')) {
    return trimmed
  }

  // Allow data URLs starting with data:image/ (image types only)
  if (options.allowDataUrl && trimmed.startsWith('data:image/')) {
    return trimmed
  }

  // Accept only absolute URLs; do not use a base URL, to avoid resolving relative paths against the current domain
  // Check whether it starts with http:// or https://
  if (!trimmed.match(/^https?:\/\//i)) {
    return ''
  }

  try {
    const parsed = new URL(trimmed)
    const protocol = parsed.protocol.toLowerCase()
    if (protocol !== 'http:' && protocol !== 'https:') {
      return ''
    }
    return parsed.toString()
  } catch {
    return ''
  }
}
