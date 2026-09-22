const MAX_ORIGINS = 20
const MAX_ORIGIN_LENGTH = 2048

/** Accept an exact HTTP(S) origin, optionally followed by one trailing slash. */
export function normalizeOrigin(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > MAX_ORIGIN_LENGTH
    || !/^https?:\/\/[^/\\\s?#@*]+\/?$/i.test(value)) return undefined
  try {
    const url = new URL(value)
    if (!url.hostname || url.hostname.includes('*') || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return undefined
    return url.origin
  } catch {
    return undefined
  }
}

export function normalizeAllowedOrigins(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_ORIGINS) {
    throw new TypeError(`allowedOrigins must be an array of at most ${MAX_ORIGINS} exact HTTP(S) origins`)
  }
  const origins = value.map(normalizeOrigin)
  if (origins.some(origin => origin === undefined)) {
    throw new TypeError(`allowedOrigins must contain exact HTTP(S) origins up to ${MAX_ORIGIN_LENGTH} characters, without wildcards, credentials, paths, queries, or fragments`)
  }
  return [...new Set(origins as string[])]
}
