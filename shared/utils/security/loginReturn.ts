/** Query parameter of a sign-in link naming the page to come back to (`/auth/github?return=/pricing`). */
export const LOGIN_RETURN_PARAM = 'return'

const MAX_RETURN_LENGTH = 512
const BASE = 'https://markoto.invalid'

/**
 * Prefixes a sign-in never returns to: the sign-in routes themselves (a
 * loop) and machine endpoints.
 */
const REFUSED_PREFIXES = ['/auth/', '/api/', '/_', '/scim/', '/mcp']

/**
 * A page of this site to return to after signing in, as path + query
 * (no hash), or null for anything else: an absolute or protocol-relative
 * URL (`//evil.example`, `/\evil.example`), control characters, an
 * over-long value, or a refused prefix. The result is rebuilt from the
 * parsed URL, so what is redirected to is exactly what was checked.
 */
export function safeLoginReturnPath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_RETURN_LENGTH) return null
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return null
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(value)) return null
  let url: URL
  try {
    url = new URL(value, BASE)
  } catch {
    return null
  }
  if (url.origin !== BASE || url.pathname.startsWith('//')) return null
  if (REFUSED_PREFIXES.some(prefix => url.pathname === prefix.replace(/\/$/, '') || url.pathname.startsWith(prefix))) return null
  return url.pathname + url.search
}

/** A sign-in path with the page to return to (the path alone when there is none or it is refused). */
export function withLoginReturn(loginPath: string, returnTo: string | null | undefined): string {
  const safe = safeLoginReturnPath(returnTo)
  if (!safe) return loginPath
  const separator = loginPath.includes('?') ? '&' : '?'
  return `${loginPath}${separator}${LOGIN_RETURN_PARAM}=${encodeURIComponent(safe)}`
}

/** `path` with one more query parameter (the callback's `signed_up=<provider>`). */
export function appendQueryParam(path: string, key: string, value: string): string {
  const url = new URL(path, BASE)
  url.searchParams.set(key, value)
  return url.pathname + url.search
}
