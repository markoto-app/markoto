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
 */
export const PAGEDJS_VERSION = '0.4.3'
export const PAGEDJS_POLYFILL_URL = `https://cdn.jsdelivr.net/npm/pagedjs@${PAGEDJS_VERSION}/dist/paged.polyfill.min.js`
