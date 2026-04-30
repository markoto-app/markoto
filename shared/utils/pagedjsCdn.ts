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
