// Content-Security-Policy for the internal print page (/_internal/render/:docId).
//
// The renderer sidecar loads that page straight from the app container, so
// Traefik's security-headers middleware (and its CSP) never applies. The
// renderer also filters every request at the browser-context level
// (renderer/src/allowlist.ts); this header is the second layer, enforced by
// Chromium itself, and mirrors the same allowlist: the page's own origin, the
// pinned CDNs, the S3 host presigned images resolve to, and any operator
// extras from RENDERER_ALLOWED_ORIGINS (same variable the renderer reads).

const CDN = 'https://cdn.jsdelivr.net'

/** Origin of an absolute http(s) URL, or null. */
function httpOrigin(value: string | undefined): string | null {
  if (!value) return null
  try {
    const parsed = new URL(value.trim())
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : null
  } catch {
    return null
  }
}

export interface RenderCspInput {
  /** Origin presigned document-image URLs point at (public S3 endpoint, else the S3 endpoint). */
  s3Origin: string | undefined
  /** Raw RENDERER_ALLOWED_ORIGINS value (comma-separated origins). */
  extraOrigins: string | undefined
}

export function buildRenderCsp({ s3Origin, extraOrigins }: RenderCspInput): string {
  const extras = (extraOrigins ?? '').split(',').map(httpOrigin)
  const imgOrigins = [httpOrigin(s3Origin), ...extras]
    .filter((o): o is string => o !== null)
  const imgSrc = ['\'self\'', 'data:', 'blob:', ...new Set(imgOrigins)].join(' ')
  return [
    'default-src \'none\'',
    // Nuxt's inline payload + paged.js need inline/eval; mermaid is a dynamic import from the CDN.
    `script-src 'self' 'unsafe-inline' 'unsafe-eval' ${CDN}`,
    `style-src 'self' 'unsafe-inline' ${CDN} https://fonts.googleapis.com`,
    `font-src 'self' data: https://fonts.gstatic.com ${CDN}`,
    `img-src ${imgSrc}`,
    `connect-src 'self' ${CDN}`,
    'frame-src \'none\'',
    'object-src \'none\'',
    'base-uri \'self\'',
    'form-action \'none\''
  ].join('; ')
}
