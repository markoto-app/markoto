import { vendorUrl } from './vendorAssets'

/**
 * Same-origin URL of the paged.js polyfill bundle, used by both the live
 * preview iframe (`usePagedPreview`) and the PDF print iframe
 * (`printPdf`), plus the server render page.
 *
 * Copied from `node_modules/pagedjs/dist/` at build time
 * (modules/vendor-assets.ts — see shared/utils/vendorAssets.ts). paged.js's
 * package "exports" field blocks a Vite `?url` import of `dist/`, and the
 * srcdoc iframes can't use Vite-injected assets anyway, so the file is
 * served as a plain static asset.
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
 *
 * To bump: change the `pagedjs` version in package.json AND here, then
 * recompute the hash:
 *   openssl dgst -sha384 -binary node_modules/pagedjs/dist/paged.polyfill.min.js | openssl base64 -A
 * The build refuses to start while version or hash disagree with the
 * installed package.
 */
export const PAGEDJS_VERSION = '0.4.3'
export const PAGEDJS_POLYFILL_URL = vendorUrl('pagedjs', PAGEDJS_VERSION, 'paged.polyfill.min.js')

/**
 * Subresource Integrity hash for the paged.js polyfill (the exact bytes
 * of the npm package's `dist/paged.polyfill.min.js`). The file is now
 * first-party, but SRI stays: a tampered build artefact or a cache in
 * between still can't run other code in every preview/print iframe.
 */
export const PAGEDJS_POLYFILL_SRI = 'sha384-y6+mefdjvGUaOPOrIMXHgP6Wwpza9G0N1QW1YUteLiwb50olbeI7H909UwZTMuVX'
