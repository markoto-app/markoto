import { vendorUrl } from './vendorAssets'

/**
 * Same-origin URL for the KaTeX stylesheet used by the paged.js preview
 * AND the PDF print iframes. Copied (unmodified) from
 * `node_modules/katex/dist/` at build time together with its woff2 fonts
 * (`fonts/` next to the stylesheet, which references them relatively) —
 * modules/vendor-assets.ts, see shared/utils/vendorAssets.ts.
 *
 * Why not imported via Vite: KaTeX's CSS would land in the parent
 * document, but srcdoc iframes don't inherit parent stylesheets. Linking
 * it inside the iframe bootstrap puts the styles where they're needed —
 * same pattern as hljsAssets.ts.
 *
 * The version is the one installed in package.json (also forced onto
 * @mdit/plugin-katex via `overrides`). KaTeX 0.18 prefixed its internal
 * CSS classes, so a stylesheet from another minor line mis-renders the
 * markup — the build fails when this constant and the installed package
 * disagree.
 */
export const KATEX_VERSION = '0.18.11'

export const KATEX_CSS_URL = vendorUrl('katex', KATEX_VERSION, 'katex.min.css')

/**
 * Subresource Integrity hash for the KaTeX stylesheet (exact bytes of the
 * npm package's `dist/katex.min.css`). A poisoned stylesheet could
 * exfiltrate via attribute selectors + url() requests, hide content, or
 * replace glyphs to alter math rendering — so it stays SRI-locked even
 * though it is first-party now.
 *
 * To bump: change KATEX_VERSION (and package.json), then run
 *   openssl dgst -sha384 -binary node_modules/katex/dist/katex.min.css | openssl base64 -A
 * and replace KATEX_CSS_SRI with `sha384-<new>`.
 */
export const KATEX_CSS_SRI = 'sha384-NJ/T2p1ROqNH3Yico+wdWm5Rv2rlinAOvV25Sw1zLOaxg8yLDPVv8GGAUccx50rh'
