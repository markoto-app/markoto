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
 * Pinned to the version installed in package.json (also forced onto
 * @mdit/plugin-katex via `overrides`). Update both together — KaTeX 0.18
 * prefixed its internal CSS classes, so a stylesheet from another minor
 * line mis-renders the markup. The URL is versioned so old caches don't
 * bleed.
 */
export const KATEX_VERSION = '0.18.11'

export const KATEX_CSS_URL = `https://cdn.jsdelivr.net/npm/katex@${KATEX_VERSION}/dist/katex.min.css`

/**
 * Subresource Integrity hash for the KaTeX stylesheet. Pinned to the
 * exact bytes of the URL above. CSS-only attacks are narrower than JS
 * (no script execution) but a poisoned stylesheet can still exfiltrate
 * via attribute selectors + url() requests, hide content, or replace
 * glyphs to alter math rendering — and Workbox would persist the
 * poisoned bytes for 30 days. Lock it down anyway.
 *
 * To bump the version: change KATEX_VERSION above, then run:
 *   curl -sSL <NEW_URL> | openssl dgst -sha384 -binary | openssl base64 -A
 * Replace KATEX_CSS_SRI with `sha384-<new>`. Both MUST update together
 * or the stylesheet will be blocked by the browser.
 */
export const KATEX_CSS_SRI = 'sha384-NJ/T2p1ROqNH3Yico+wdWm5Rv2rlinAOvV25Sw1zLOaxg8yLDPVv8GGAUccx50rh'
