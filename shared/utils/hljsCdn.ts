import type { CodeTheme } from '../types/theme'

/**
 * CDN URL for the highlight.js theme stylesheet used by the paged.js
 * preview AND the PDF print iframes.
 *
 * Why CDN instead of bundling: highlight.js's CSS would otherwise be
 * imported via Vite into the parent document, but srcdoc iframes don't
 * inherit parent stylesheets. Loading from CDN inside the iframe
 * bootstrap puts the styles where they're actually needed.
 *
 * Workbox caches `cdn.jsdelivr.net/*`, so first load is online but
 * subsequent reloads work offline.
 *
 * Pinned to the version installed in package.json. Update both
 * together; the URL is versioned so old caches don't bleed.
 */
export const HLJS_VERSION = '11.11.1'

/**
 * Resolve the highlight.js stylesheet URL for the given code theme. An
 * empty return signals the caller to skip the stylesheet entirely
 * (corresponds to `code.theme: 'none'`); theme CSS strips `.hljs`
 * background/color so the block reads as plain monospace.
 */
export function hljsThemeUrl(theme: CodeTheme): string {
  if (theme === 'none') return ''
  // Path on cdn.jsdelivr.net is `styles/<name>.min.css` for top-level
  // themes and `styles/base16/<name>.min.css` for the base16 family.
  const themePath: Record<Exclude<CodeTheme, 'none'>, string> = {
    'github-light': 'github',
    'github-dark': 'github-dark',
    'monokai': 'monokai',
    'dracula': 'base16/dracula',
    'solarized-light': 'base16/solarized-light',
    'solarized-dark': 'base16/solarized-dark'
  }
  return `https://cdn.jsdelivr.net/npm/highlight.js@${HLJS_VERSION}/styles/${themePath[theme]}.min.css`
}
