/**
 * CDN URL + Subresource Integrity hash for the Mermaid bundle used by the
 * live preview iframe, the browser print iframe and the server render page.
 *
 * Why CDN instead of bundling: Mermaid is ~3.5 MB minified. Pulling it into
 * the Nuxt client bundle would balloon initial load for every user, even
 * those who never write a diagram. It is fetched lazily, only when a
 * `language-mermaid` code block is actually present in the rendered HTML,
 * and Workbox caches `cdn.jsdelivr.net/*` so later uses work offline.
 *
 * Why the single-file IIFE build (`mermaid.min.js`, sets `globalThis.mermaid`)
 * and not the ESM build: the ESM entry (`mermaid.esm.min.mjs`) is code-split
 * into ~100 lazily imported chunks, and browsers cannot enforce SRI on
 * `import()` or on the chunks a module pulls in. The IIFE build is one file
 * loaded through a classic `<script integrity=… crossorigin=anonymous>`, so
 * the browser refuses anything but these exact bytes — a jsDelivr compromise
 * cannot inject code through it. The CSP allows exactly this URL path.
 *
 * Pinned to a CONCRETE patch version so the bytes on the wire are stable.
 * To bump: change MERMAID_VERSION, then run
 *   curl -sSL <NEW_URL> | openssl dgst -sha384 -binary | openssl base64 -A
 * and replace MERMAID_SRI with `sha384-<new>`. Both MUST update together or
 * the browser refuses the script (diagrams render as "Mermaid error").
 */
export const MERMAID_VERSION = '11.17.2'

export const MERMAID_URL = `https://cdn.jsdelivr.net/npm/mermaid@${MERMAID_VERSION}/dist/mermaid.min.js`

export const MERMAID_SRI = 'sha384-EOXBFmc3gx5mb+vn0vPvvGqACToJD24hhacX5Yx+8NUUQrHIle/Qi5Bg9o3zKwW2'
