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
 *
 * SRI rationale (intentionally NOT enforced for hljs):
 * Unlike paged.js, KaTeX, and mermaid, the hljs theme stylesheets do
 * NOT carry SRI hashes. We picked option (b) — skip SRI, document why:
 *
 *   1. The function returns one of ~30+ different theme URLs depending
 *      on user preference. Computing + maintaining a Record<theme, sri>
 *      lookup would mean re-hashing all themes on every hljs version
 *      bump (and getting the build to choke on a single mismatch).
 *   2. The stylesheet is loaded ONLY into the same-origin srcdoc iframe
 *      (live preview) or hidden print iframe — neither has access to
 *      cookies, OAuth session, or any privileged DOM the parent app
 *      cares about. A poisoned hljs stylesheet's blast radius is
 *      "the user's code blocks render with attacker-controlled colors".
 *   3. CSS-injection-via-attribute-selector exfil exists in theory but
 *      hljs themes don't touch user-attributed nodes (no `[href]`,
 *      `[data-token]`, etc. selectors); they target `.hljs-*` classes
 *      added by highlight.js itself, which carry no secrets.
 *
 * If the threat model changes (e.g. we start rendering secrets inside
 * `<pre>` blocks the iframe can read), revisit this decision and adopt
 * option (a) — pre-compute SRI for every theme into a lookup table.
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
