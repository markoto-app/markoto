import { vendorUrl } from './vendorAssets'

/**
 * Same-origin URL + Subresource Integrity hash for the Mermaid bundle used
 * by the live preview iframe, the browser print iframe and the server
 * render page. Copied from `node_modules/mermaid/dist/` at build time
 * (modules/vendor-assets.ts — see shared/utils/vendor/vendorAssets.ts).
 *
 * Why not bundled into the Nuxt client: Mermaid is ~3.5 MB minified.
 * Pulling it into the client bundle would balloon initial load for every
 * user, even those who never write a diagram. It is fetched lazily, only
 * when a `language-mermaid` code block is actually present in the
 * rendered HTML.
 *
 * Why the single-file IIFE build (`mermaid.min.js`, sets `globalThis.mermaid`)
 * and not the ESM build: the ESM entry (`mermaid.esm.min.mjs`) is code-split
 * into ~100 lazily imported chunks, and browsers cannot enforce SRI on
 * `import()` or on the chunks a module pulls in. The IIFE build is one file
 * loaded through a classic `<script integrity=… crossorigin=anonymous>`, so
 * the browser refuses anything but these exact bytes.
 *
 * To bump: change the `mermaid` version in package.json (devDependencies,
 * exact) AND here, then recompute the hash:
 *   openssl dgst -sha384 -binary node_modules/mermaid/dist/mermaid.min.js | openssl base64 -A
 * The build refuses to start while version or hash disagree with the
 * installed package (diagrams would otherwise render as "Mermaid error").
 */
export const MERMAID_VERSION = '11.17.2'

export const MERMAID_URL = vendorUrl('mermaid', MERMAID_VERSION, 'mermaid.min.js')

export const MERMAID_SRI = 'sha384-EOXBFmc3gx5mb+vn0vPvvGqACToJD24hhacX5Yx+8NUUQrHIle/Qi5Bg9o3zKwW2'
