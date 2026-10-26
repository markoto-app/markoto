/**
 * CDN URL for the Mermaid ESM module used by the paged.js preview AND
 * the PDF print iframes.
 *
 * Why CDN instead of bundling: Mermaid's full bundle is ~1MB minified
 * gzipped. Pulling it into the Nuxt client bundle would balloon initial
 * load for every user, even those who never write a diagram. Loading
 * lazily from CDN inside the iframe means it's only fetched when a
 * `language-mermaid` code block is actually present in the rendered
 * HTML. Workbox caches `cdn.jsdelivr.net/*`, so subsequent uses work
 * offline.
 *
 * ESM build only — `mermaid.esm.min.mjs` is the import-target. The UMD
 * `mermaid.min.js` exists but doesn't tree-shake; ESM is what the v11
 * docs steer integrations toward.
 *
 * Pinned to a CONCRETE patch version (not the `@11` major channel) so
 * the bytes-on-the-wire are stable enough to attach an SRI hash to.
 * The `@11` channel is a moving target — every minor/patch release
 * silently changes the bytes at the same URL, which would break SRI
 * on every upgrade. Bump intentionally; verify diagrams render; then
 * recompute the SRI alongside.
 *
 * To bump the version: change MERMAID_VERSION, then run:
 *   curl -sSL <NEW_URL> | openssl dgst -sha384 -binary | openssl base64 -A
 * Replace MERMAID_ESM_SRI with `sha384-<new>`. Both must update together.
 *
 * NOTE on enforcement: browsers do NOT yet enforce SRI on bare dynamic
 * `import(...)` calls. The constant below is computed and exported for
 * future use (import-maps-with-integrity proposal) and for documentation
 * of the expected bytes, but the actual `import(MERMAID_ESM_URL)` call
 * sites will not validate it today. Treat mermaid as best-effort SRI
 * until the spec lands.
 */
export const MERMAID_VERSION = '11.17.2'

export const MERMAID_ESM_URL = `https://cdn.jsdelivr.net/npm/mermaid@${MERMAID_VERSION}/dist/mermaid.esm.min.mjs`

export const MERMAID_ESM_SRI = 'sha384-WpV0mnoAILtx5vne0am/qjdpWLSB/nef78GMd221pz6JKoZNgONGZbSu4ppDDPx/'
