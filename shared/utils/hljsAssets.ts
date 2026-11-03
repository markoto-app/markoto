import type { CodeTheme } from '../types/theme'
import { vendorUrl } from './vendorAssets'

/**
 * Same-origin URL + SRI hash for the highlight.js theme stylesheet used by
 * the paged.js preview, the browser print iframe and the server render
 * page. Copied (unmodified) from `node_modules/highlight.js/styles/` at
 * build time — modules/vendor-assets.ts, see shared/utils/vendorAssets.ts.
 *
 * Why not imported via Vite: the CSS would land in the parent document,
 * but srcdoc iframes don't inherit parent stylesheets; linking it inside
 * the iframe bootstrap puts the styles where they're actually needed.
 *
 * Every theme stylesheet is SRI-locked (`hljsTheme(theme).sri`). A
 * CSS-only attack is narrower than JS, but attribute selectors + url()
 * can still exfiltrate or alter what the reader sees.
 *
 * To bump: change HLJS_VERSION (and package.json), then recompute every
 * hash below:
 *   openssl dgst -sha384 -binary node_modules/highlight.js/styles/<path>.min.css | openssl base64 -A
 * The build refuses to start while a hash disagrees with the installed
 * package.
 */
export const HLJS_VERSION = '11.12.0'

type HljsThemeName = Exclude<CodeTheme, 'none'>

/** Path under `styles/` + SRI hash of each theme's minified stylesheet. */
export const HLJS_THEMES: Record<HljsThemeName, { path: string, sri: string }> = {
  'github-light': { path: 'github', sri: 'sha384-eFTL69TLRZTkNfYZOLM+G04821K1qZao/4QLJbet1pP4tcF+fdXq/9CdqAbWRl/L' },
  'github-dark': { path: 'github-dark', sri: 'sha384-wH75j6z1lH97ZOpMOInqhgKzFkAInZPPSPlZpYKYTOqsaizPvhQZmAtLcPKXpLyH' },
  'monokai': { path: 'monokai', sri: 'sha384-Exar9WeMELq1EieDQNh7c2ggVht9/FEoVtGG2JKgmEwcm5zOXQwPMzp3PEsPJ/zq' },
  'dracula': { path: 'base16/dracula', sri: 'sha384-8yvztywXIMtiE+HRhcQsx4/deaeolO/VC3gouoTc7kgVhEdHJ3nJwSU5fzO9HgUV' },
  'solarized-light': { path: 'base16/solarized-light', sri: 'sha384-rnjP0mbM8/cpKzcxL41jkXETTXZTqLAxYj/Xt5x4/j+UsOi1hseTJVw+YdXRbbbi' },
  'solarized-dark': { path: 'base16/solarized-dark', sri: 'sha384-xAOMWIFDjsMwim+nhPTvySn//mxqBQRxRtIyNbZ/uYLGKS7YZNlnhNmEIs0BW+hJ' }
}

/** Every highlight.js stylesheet lives under this prefix. */
export const HLJS_STYLES_BASE = vendorUrl('highlight.js', HLJS_VERSION, 'styles/')

/**
 * Resolve the highlight.js stylesheet for the given code theme. An empty
 * `url` signals the caller to skip the stylesheet entirely (corresponds
 * to `code.theme: 'none'`); theme CSS strips `.hljs` background/color so
 * the block reads as plain monospace.
 */
export function hljsTheme(theme: CodeTheme): { url: string, sri: string } {
  if (theme === 'none') return { url: '', sri: '' }
  const entry = HLJS_THEMES[theme]
  return { url: `${HLJS_STYLES_BASE}${entry.path}.min.css`, sri: entry.sri }
}

/** URL-only shorthand for `hljsTheme(theme).url`. */
export function hljsThemeUrl(theme: CodeTheme): string {
  return hljsTheme(theme).url
}
