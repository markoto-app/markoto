import { VENDOR_BASE } from '../../../shared/utils/vendor/vendorAssets'
import { FONT_STYLESHEET_BASE } from '../../../shared/utils/theme/themeFonts'

/**
 * Response headers for the same-origin third-party assets under /vendor/
 * (shared/utils/vendor/vendorAssets.ts), or null for any other path.
 *
 *   - `Access-Control-Allow-Origin: *` — the live preview / print iframes
 *     run in an opaque origin, so for them even our own origin is
 *     cross-origin: fonts are always fetched in CORS mode, and the SRI-locked
 *     `<script>` / `<link>` tags carry `crossorigin="anonymous"`. Public,
 *     credential-less static files, so `*` is fine. (CORP `cross-origin`
 *     comes from `crossOriginResourcePolicyFor` in csp.ts.)
 *   - `Cache-Control` — every file sits under a versioned directory
 *     (`<package>@<version>/`), so it never changes: immutable for a year.
 *     The per-family font stylesheets (`/vendor/fonts/<family>.css`) are the
 *     one unversioned name — they point at the versioned font files, so they
 *     revalidate (ETag) on every use and a font-package bump takes effect at
 *     once.
 */
export function vendorAssetHeaders(path: string): Record<string, string> | null {
  const pathname = path.split('?')[0] ?? ''
  if (!pathname.startsWith(VENDOR_BASE)) return null
  const isFontStylesheet = pathname.startsWith(FONT_STYLESHEET_BASE)
    && pathname.endsWith('.css')
    && !pathname.slice(FONT_STYLESHEET_BASE.length).includes('/')
  return {
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': isFontStylesheet ? 'no-cache' : 'public, max-age=31536000, immutable'
  }
}
