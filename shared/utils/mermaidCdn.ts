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
 * Pinned to a major version. Mermaid follows semver loosely; staying on
 * the v11 channel lets us pick up security fixes without compatibility
 * surprises. Bump the major intentionally and verify diagrams render.
 */
export const MERMAID_VERSION = '11'

export const MERMAID_ESM_URL = `https://cdn.jsdelivr.net/npm/mermaid@${MERMAID_VERSION}/dist/mermaid.esm.min.mjs`
