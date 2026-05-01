/**
 * CDN URL for the paged.js polyfill bundle, used by both the live preview
 * iframe (`usePagedPreview`) and the PDF print iframe (`printPdf`).
 *
 * Pinned to the same version installed in package.json. Update both when
 * upgrading paged.js — the `?url` import dance via Vite was an option but
 * paged.js's package "exports" field blocks subpath access into `dist/`,
 * which made all the local-bundling paths require workarounds (Nitro
 * endpoint reading from node_modules, custom Vite alias, etc.). The CDN
 * is simpler, the URL is versioned for automatic cache-busting, and the
 * PWA service worker (nuxt.config.ts → pwa.workbox.runtimeCaching) caches
 * `cdn.jsdelivr.net/*` so subsequent loads are offline-friendly.
 *
 * ⚠ DO NOT BUMP WITHOUT VERIFYING the modern-CSS workaround in
 * `app/pages/_internal/render/[docId].vue`. paged.js 0.4.3's CSS atrule
 * parser does not understand `oklch()` / `color-mix()`. Nuxt UI injects
 * a `<style id="nuxt-ui-colors">` block full of oklch() values during
 * SSR; if paged.js's polisher scans it (as it does in `auto: true` mode)
 * it crashes deep in `atrules` parsing with "Cannot read properties of
 * undefined". Our fix is the explicit-stylesheets API call:
 * `Previewer.preview(html, [{ 'theme.css': themeCss }], mount)` — the
 * Polisher only processes the explicitly-passed stylesheet, so Nuxt's
 * oklch() block is invisible. Upgrading paged.js may either fix the
 * underlying parser OR remove the explicit-stylesheets API. Test with
 * `bun scripts/compare-pdf-vs-png.mjs` against a multi-page doc before
 * shipping any version bump.
 */
export const PAGEDJS_VERSION = '0.4.3'
export const PAGEDJS_POLYFILL_URL = `https://cdn.jsdelivr.net/npm/pagedjs@${PAGEDJS_VERSION}/dist/paged.polyfill.min.js`

/**
 * Subresource Integrity hash for the paged.js polyfill. Pinned to the
 * exact bytes of the URL above. Without this, a jsdelivr compromise
 * (or MITM on first load before Workbox caches the response) would
 * silently execute attacker-supplied JavaScript in every preview/print
 * iframe — and Workbox would persist the poisoned bytes for 30 days.
 *
 * To bump the version: change PAGEDJS_VERSION above, then run:
 *   curl -sSL <NEW_URL> | openssl dgst -sha384 -binary | openssl base64 -A
 * Replace PAGEDJS_POLYFILL_SRI with `sha384-<new>`. Both MUST update
 * together or the script will be blocked by the browser.
 */
export const PAGEDJS_POLYFILL_SRI = 'sha384-y6+mefdjvGUaOPOrIMXHgP6Wwpza9G0N1QW1YUteLiwb50olbeI7H909UwZTMuVX'
