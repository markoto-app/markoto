/**
 * Third-party browser assets (paged.js, Mermaid, KaTeX CSS + fonts,
 * highlight.js themes, the web fonts) are served from the app's own
 * origin under `/vendor/`, never from a CDN: visitors' browsers and the
 * renderer sidecar make no third-party request, and an air-gapped
 * self-hosted instance renders previews and PDFs without internet.
 *
 * `modules/vendor-assets.ts` copies the files out of the pinned npm
 * packages at `nuxt build` / `nuxt dev` (manifest + checks:
 * `scripts/lib/vendorAssets.ts`). The `*Assets.ts` modules next to this
 * one hold each package's version + SRI hash; the build fails when the
 * installed package's version or bytes differ from them, and
 * `tests/unit/rendering/vendorAssets.test.ts` pins the same.
 *
 * Paths are versioned (`/vendor/<package>@<version>/…`) and served
 * `immutable`, so a bump is a new URL, no stale cache, no Workbox purge.
 * The preview / print iframes run in an opaque origin, so these paths
 * are served with `Cross-Origin-Resource-Policy: cross-origin` and
 * `Access-Control-Allow-Origin: *` (`vendorAssetHeaders` in
 * server/utils/rendering/vendorAssetHeaders.ts).
 */

/** Public URL prefix of every vendored asset. */
export const VENDOR_BASE = '/vendor/'

/** `/vendor/<pkg>@<version>/<file>`: the URL of a file vendored from an npm package. */
export function vendorUrl(pkg: string, version: string, file: string): string {
  return `${VENDOR_BASE}${pkg}@${version}/${file}`
}
