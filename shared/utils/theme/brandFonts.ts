import { BRAND_FONT_CSS_FORMAT, BRAND_FONT_FAMILY_RE, type BrandFont } from '../../config/brandKit'

/**
 * `@font-face` rules for a workspace's brand-kit fonts, appended to
 * the theme's font imports in all three renderers (live preview, browser
 * print, server render page). Every workspace font is declared — a theme,
 * a per-level heading font or custom CSS may name any of them — and the
 * browser downloads only the faces the page actually uses.
 *
 * `urlFor(file)` is where this renderer loads `<assetId>.<ext>` from (the
 * document route with the file-access token). Family names and files are
 * re-checked here, so a list that didn't come from our API can't inject
 * CSS: families match the theme font-name pattern (letters, digits,
 * spaces), files `<16 id chars>.<ext>`, and the URL is quoted.
 */
export function brandFontFaceCss(fonts: readonly BrandFont[] | null | undefined, urlFor: (file: string) => string): string {
  if (!fonts?.length) return ''
  const rules: string[] = []
  for (const f of fonts) {
    if (!BRAND_FONT_FAMILY_RE.test(f.family)) continue
    if (!/^[A-Za-z0-9_-]{16}\.(?:woff2|woff|ttf)$/.test(f.file)) continue
    const format = BRAND_FONT_CSS_FORMAT[f.format]
    if (!format) continue
    const weight = Number.isInteger(f.weight) && f.weight >= 100 && f.weight <= 900 ? f.weight : 400
    const style = f.style === 'italic' ? 'italic' : 'normal'
    const url = urlFor(f.file).replace(/['\\\n\r]/g, '')
    if (!url) continue
    rules.push(`@font-face { font-family: '${f.family}'; src: url('${url}') format('${format}'); font-weight: ${weight}; font-style: ${style}; font-display: swap; }`)
  }
  return rules.join('\n')
}

/** Families of the workspace fonts, deduplicated, for the theme panel's pickers. */
export function brandFontFamilies(fonts: readonly BrandFont[] | null | undefined): string[] {
  return [...new Set((fonts ?? []).map(f => f.family))].sort((a, b) => a.localeCompare(b))
}
