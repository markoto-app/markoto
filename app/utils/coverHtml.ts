import type { DocTheme } from '~~/shared/types/theme'
import { isThemeImageUrl } from '~~/shared/utils/themeImages'

/**
 * Build the cover-page HTML when `theme.cover.enabled`. Returns the
 * empty string when disabled (caller can blindly concatenate).
 *
 * Output structure:
 *   <section class="markoto-cover">
 *     <img class="markoto-cover-logo" ...>     ← when cover.showLogo + brand.logoUrl
 *     <h1 class="markoto-cover-title">…</h1>   ← when cover.showTitle + title
 *     <div class="markoto-cover-subtitle">…</div>
 *     <div class="markoto-cover-meta">
 *       <div class="markoto-cover-author">…</div>×N
 *       <div class="markoto-cover-date">…</div>
 *     </div>
 *   </section>
 *
 * Design notes:
 *   - `<h1>` + `<div>` only, never `<p>` — `wrapFirstLetterAsDropCap`
 *     would otherwise grab the cover subtitle's first letter; cover
 *     uses block-level non-paragraph tags so the dropcap regex skips
 *     past it to the body's first paragraph.
 *   - Empty values are skipped (no zero-content `<h1></h1>`).
 *   - Logo `<img>` only emitted when both the toggle AND the URL are
 *     set; otherwise we'd render a broken image placeholder.
 *   - Author entries with empty/whitespace strings are dropped.
 *   - All text values are HTML-escaped — even though theme JSONB is
 *     validated at intake, defense-in-depth: title, subtitle, author
 *     names and the date string all go through `esc`.
 *   - The logo URL lands in an attribute. The theme can arrive over
 *     Y.js without HTTP validation, so the builder re-checks the shape
 *     itself (`isThemeImageUrl`: upload path or bundled asset, no quotes
 *     possible) AND escapes it for attribute context. `composeFinalHtml`
 *     additionally sanitises the composed document.
 */
export function buildCoverHtml(theme: DocTheme, title: string, dateText: string): string {
  if (!theme.cover.enabled) return ''
  const logo = buildLogoHtml(theme)
  const parts = [
    logo,
    buildTitleHtml(theme, title),
    buildSubtitleHtml(theme),
    buildMetaHtml(theme, dateText)
  ].filter(Boolean)
  // Layout CSS adds an accent where the logo would be (themeToCss).
  const cls = logo ? 'markoto-cover' : 'markoto-cover markoto-cover--no-logo'
  return `<section class="${cls}">${parts.join('')}</section>`
}

function buildLogoHtml(theme: DocTheme): string {
  const url = theme.brand.logoUrl
  if (!theme.cover.showLogo || !url || !isThemeImageUrl(url)) return ''
  return `<img class="markoto-cover-logo" src="${escAttr(url)}" alt="">`
}

function buildTitleHtml(theme: DocTheme, title: string): string {
  if (!theme.cover.showTitle || !title) return ''
  return `<h1 class="markoto-cover-title">${esc(title)}</h1>`
}

function buildSubtitleHtml(theme: DocTheme): string {
  if (!theme.cover.showSubtitle || !theme.cover.subtitle) return ''
  return `<div class="markoto-cover-subtitle">${esc(theme.cover.subtitle)}</div>`
}

/** Author + date block. Empty when neither toggle is on AND neither produces text. */
function buildMetaHtml(theme: DocTheme, dateText: string): string {
  const metaParts: string[] = []
  if (theme.cover.showAuthors) {
    for (const author of theme.cover.authors) {
      const trimmed = author.trim()
      if (trimmed) metaParts.push(`<div class="markoto-cover-author">${esc(trimmed)}</div>`)
    }
  }
  if (theme.cover.showDate && dateText) {
    metaParts.push(`<div class="markoto-cover-date">${esc(dateText)}</div>`)
  }
  if (metaParts.length === 0) return ''
  return `<div class="markoto-cover-meta">${metaParts.join('')}</div>`
}

/** Minimal HTML escape for text interpolated into element bodies. */
function esc(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/** HTML escape for a double-quoted attribute value (quotes included). */
function escAttr(s: string): string {
  return esc(s).replaceAll('"', '&quot;').replaceAll('\'', '&#39;')
}
