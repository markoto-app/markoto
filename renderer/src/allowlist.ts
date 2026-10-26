// Network allowlist for the renderer's Chromium.
//
// The renderer navigates straight to the app container (no Traefik in the
// path, so no Content-Security-Policy) and renders attacker-influenced
// markdown. Without a filter, `![](http://169.254.169.254/...)` or
// `![](http://litellm:4000/...)` makes THIS container — which sits on the
// internal network — issue the request (blind SSRF, and image responses land
// in the PDF). Every request the browser context makes is checked against the
// origin set built here; anything else is aborted.
//
// Pure module (no Playwright import) so it is unit-testable from tests/unit.

/** CDN hosts the print page loads: paged.js / mermaid / hljs / KaTeX (jsDelivr) and Google Fonts. */
export const DEFAULT_CDN_ORIGINS: readonly string[] = [
  'https://cdn.jsdelivr.net',
  'https://fonts.googleapis.com',
  'https://fonts.gstatic.com'
]

export interface AllowlistEnv {
  APP_URL?: string
  S3_ENDPOINT?: string
  S3_PUBLIC_ENDPOINT?: string
  RENDERER_ALLOWED_ORIGINS?: string
}

/** Normalise a URL-ish string to its origin, or null when it isn't an absolute http(s) URL. */
export function originOf(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  return parsed.origin
}

/**
 * Build the allowed-origin set from the renderer's environment:
 *   - the app origin (`APP_URL`) it was told to render,
 *   - the host presigned image URLs point at: `S3_PUBLIC_ENDPOINT` when set
 *     (self-host: S3 is reached internally but published under the public
 *     origin), else `S3_ENDPOINT` (hosted: same external URL on both sides),
 *   - the pinned CDN hosts,
 *   - operator extras from `RENDERER_ALLOWED_ORIGINS` (comma-separated origins).
 */
export function buildAllowedOrigins(env: AllowlistEnv): Set<string> {
  const origins = new Set<string>(DEFAULT_CDN_ORIGINS)
  const candidates = [
    env.APP_URL ?? '',
    env.S3_PUBLIC_ENDPOINT || env.S3_ENDPOINT || '',
    ...(env.RENDERER_ALLOWED_ORIGINS ?? '').split(',')
  ]
  for (const candidate of candidates) {
    const origin = originOf(candidate)
    if (origin) origins.add(origin)
  }
  return origins
}

/**
 * Is the browser allowed to request this URL? `data:`, `blob:` and
 * `about:blank` never leave the browser. http(s) must match an allowed origin
 * exactly (scheme + host + port). Everything else — ws(s), ftp, file, … — is
 * refused.
 */
export function isAllowedUrl(url: string, allowedOrigins: ReadonlySet<string>): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  switch (parsed.protocol) {
    case 'data:':
    case 'blob:':
      return true
    case 'about:':
      return url === 'about:blank'
    case 'http:':
    case 'https:':
      return allowedOrigins.has(parsed.origin)
    default:
      return false
  }
}

/** Host (no path, query or credentials) for logging a blocked request. */
export function hostForLog(url: string): string {
  try {
    const parsed = new URL(url)
    return parsed.host || parsed.protocol
  } catch {
    return 'unparseable'
  }
}
