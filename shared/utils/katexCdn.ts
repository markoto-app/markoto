/**
 * CDN URL for the KaTeX stylesheet used by the paged.js preview AND the
 * PDF print iframes.
 *
 * Why CDN instead of bundling: KaTeX's CSS would otherwise be imported
 * via Vite into the parent document, but srcdoc iframes don't inherit
 * parent stylesheets. Loading from CDN inside the iframe bootstrap puts
 * the styles where they're actually needed — same pattern as hljsCdn.ts.
 *
 * Workbox caches `cdn.jsdelivr.net/*`, so first load is online but
 * subsequent reloads work offline.
 *
 * Pinned to the version installed in package.json. Update both
 * together; the URL is versioned so old caches don't bleed.
 */
export const KATEX_VERSION = '0.16.45'

export const KATEX_CSS_URL = `https://cdn.jsdelivr.net/npm/katex@${KATEX_VERSION}/dist/katex.min.css`
