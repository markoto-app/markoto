// Content-Security-Policy builders — the single source of truth for every
// deployment shape (hosted prod/staging, self-host, local full stack, the
// test stacks). The app sets the header itself (server/plugins/csp.ts) with
// a per-response nonce; Traefik no longer carries a CSP label.
//
// Two policies:
//   - `buildAppCsp` — every page of the app. The live preview / print
//     iframes are srcdoc documents and inherit this policy (their inline
//     scripts carry the same nonce).
//   - `buildRenderCsp` — the internal print page (/_internal/render/:docId)
//     the renderer sidecar loads straight from the app container. Second
//     layer behind the renderer's request allowlist
//     (renderer/src/allowlist.ts): Playwright does not re-enter route() for
//     redirect hops, Chromium enforces this on every hop.
//
// Design (see docs/SECURITY-HARDENING.md §2):
//   - script-src: 'self' + the response nonce. paged.js + Mermaid are
//     same-origin /vendor/ files (shared/utils/vendorAssets.ts), still
//     SRI-locked at the tag. No 'unsafe-inline' (inline event handlers
//     and injected <script> never run), no 'unsafe-eval'. 'wasm-unsafe-eval' only on the app policy:
//     @nuxt/content compiles its SQLite WASM for client-side docs queries.
//   - style-src keeps 'unsafe-inline': Nuxt UI injects its color tokens as
//     an inline <style>, Vue/KaTeX/paged.js write inline style attributes
//     and <style> elements at runtime (paged.js generates one per render).
//     Styles can't execute script; CSS exfiltration is bounded by img-src /
//     font-src / connect-src below.
//   - No third-party origin anywhere: the web fonts, KaTeX + highlight.js
//     stylesheets and the scripts above are all served from /vendor/ —
//     visitors' browsers and the renderer talk to this origin (+ S3, sync,
//     Sentry when configured) only.

import { VENDOR_BASE } from '../../shared/utils/vendorAssets'

/** Origin of an absolute http(s)/ws(s) URL, or null. */
export function urlOrigin(value: string | undefined | null, schemes: readonly string[] = ['http:', 'https:']): string | null {
  if (!value) return null
  try {
    const parsed = new URL(value.trim())
    return schemes.includes(parsed.protocol) ? `${parsed.protocol}//${parsed.host}` : null
  } catch {
    return null
  }
}

/** A nonce is base64 — anything else must never reach the header. */
function nonceSource(nonce: string): string[] {
  return /^[A-Za-z0-9+/=]{16,}$/.test(nonce) ? [`'nonce-${nonce}'`] : []
}

function unique(values: Array<string | null>): string[] {
  return [...new Set(values.filter((v): v is string => typeof v === 'string' && v.length > 0))]
}

export interface AppCspInput {
  /** Per-response nonce (base64). */
  nonce: string
  /** NUXT_PUBLIC_SYNC_URL — Hocuspocus WebSocket (absolute ws(s) URL, or relative = same origin). */
  syncUrl?: string
  /** Browser-facing S3 base URL (NUXT_S3_PUBLIC_ENDPOINT, else NUXT_S3_ENDPOINT) — presigned GET/PUT. */
  s3Origin?: string
  /** NUXT_PUBLIC_SENTRY_DSN — browser error reporting. */
  sentryDsn?: string
  /** NUXT_SITE_URL — `upgrade-insecure-requests` only when the site is served over https. */
  siteUrl?: string
}

export function buildAppCsp(input: AppCspInput): string {
  const s3 = urlOrigin(input.s3Origin)
  const sync = urlOrigin(input.syncUrl, ['ws:', 'wss:', 'http:', 'https:'])
  const sentry = urlOrigin(input.sentryDsn)
  const directives = [
    'default-src \'self\'',
    ['script-src', '\'self\'', ...nonceSource(input.nonce), '\'wasm-unsafe-eval\''].join(' '),
    ['style-src', '\'self\'', '\'unsafe-inline\''].join(' '),
    'font-src \'self\' data:',
    ['img-src', ...unique(['\'self\'', 'data:', 'blob:', s3])].join(' '),
    ['connect-src', ...unique(['\'self\'', sync, s3, sentry])].join(' '),
    'frame-src \'self\'',
    'worker-src \'self\' blob:',
    'manifest-src \'self\'',
    'media-src \'self\' blob:',
    'object-src \'none\'',
    'base-uri \'self\'',
    'form-action \'self\'',
    'frame-ancestors \'none\''
  ]
  if (input.siteUrl?.trim().startsWith('https://')) directives.push('upgrade-insecure-requests')
  return directives.join('; ')
}

export interface RenderCspInput {
  /** Per-response nonce (base64). */
  nonce: string
  /** Origin presigned document-image URLs point at (public S3 endpoint, else the S3 endpoint). */
  s3Origin: string | undefined
  /** Raw RENDERER_ALLOWED_ORIGINS value (comma-separated origins). */
  extraOrigins: string | undefined
}

export function buildRenderCsp({ nonce, s3Origin, extraOrigins }: RenderCspInput): string {
  const extras = (extraOrigins ?? '').split(',').map(v => urlOrigin(v))
  const imgSrc = unique(['\'self\'', 'data:', 'blob:', urlOrigin(s3Origin), ...extras])
  return [
    'default-src \'none\'',
    // Nuxt's inline payload/bootstrap scripts carry the nonce; paged.js and
    // Mermaid are the SRI-locked same-origin /vendor/ files.
    ['script-src', '\'self\'', ...nonceSource(nonce)].join(' '),
    'style-src \'self\' \'unsafe-inline\'',
    'font-src \'self\' data:',
    `img-src ${imgSrc.join(' ')}`,
    'connect-src \'self\'',
    'frame-src \'none\'',
    'object-src \'none\'',
    'base-uri \'self\'',
    'form-action \'none\''
  ].join('; ')
}

/** Add `nonce="…"` to every `<script` start tag in Nuxt-generated head/body-edge chunks. */
export function addNonceToScripts(chunk: string, nonce: string): string {
  if (nonceSource(nonce).length === 0) return chunk
  return chunk.replaceAll(/<script(?=[\s>])(?![^>]*\snonce=)/g, `<script nonce="${nonce}"`)
}

/**
 * Cross-Origin-Resource-Policy for a request path.
 *
 * The live preview and print iframes run in an opaque origin, so every
 * image they load is a cross-site request, and CORP `same-site` makes
 * Chromium refuse it (`ERR_BLOCKED_BY_RESPONSE.NotSameSite`). Two kinds of
 * resource are loaded there:
 *   - `/api/files/…` (a 302 to presigned S3) — authorised by the session /
 *     file-access token, not by the origin;
 *   - `/markoto-logos/…` — the bundled brand marks the default theme puts
 *     on every cover page (`brand.logoUrl`). Public static files.
 *   - `/vendor/…` — paged.js, Mermaid, KaTeX CSS + fonts, highlight.js
 *     themes and the web fonts (shared/utils/vendorAssets.ts). Public,
 *     versioned static files; they also get `Access-Control-Allow-Origin: *`
 *     (server/utils/vendorAssetHeaders.ts) because the iframe loads them
 *     in CORS mode (SRI, fonts).
 *   - `/api/docs/<docId>/brand/<file>` — the workspace brand kit's fonts
 *     and logos (WP10), authorised by the file-access token like
 *     `/api/files`; sent with `Access-Control-Allow-Origin: *` (fonts load
 *     in CORS mode).
 * Everything else stays `same-site`. (Chromium happens to let plain
 * `localhost` through, which is why the blocked cover logo only showed on
 * real host names.)
 */
const DOC_BRAND_ASSET_PATH = /^\/api\/docs\/[^/]+\/brand\/[^/]+$/

export function crossOriginResourcePolicyFor(path: string): 'cross-origin' | 'same-site' {
  const pathname = path.split('?')[0] ?? ''
  return path.startsWith('/api/files/') || path.startsWith('/api/published/') || path.startsWith('/markoto-logos/') || path.startsWith(VENDOR_BASE) || DOC_BRAND_ASSET_PATH.test(pathname)
    ? 'cross-origin'
    : 'same-site'
}
