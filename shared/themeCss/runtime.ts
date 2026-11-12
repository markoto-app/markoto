import type { CustomCssResult } from '../types/customCss'

// Runtime values the stylesheet interpolates (title, date, localized labels,
// sanitized custom CSS).

/**
 * Runtime values interpolated into the theme CSS. Kept separate from
 * the theme itself because they change at a different cadence (title
 * on rename, date once per render) and because baking them into the
 * CSS string is simpler than the CSS-custom-property dance — paged.js
 * extracts header/footer content into margin boxes that are NOT
 * descendants of `.paged-doc`, so vars set there don't propagate.
 */
export type ThemeRuntime = {
  title: string
  /** Publication date as shown (`documentTexts().date`), for `{date}`. */
  date: string
  // Localized text rendered by CSS \`content:\` for the optional TOC
  // heading. Lives in runtime (not the theme) because i18n strings
  // shouldn't be persisted to the doc — same translation should apply
  // when the doc opens in another language.
  tocTitle: string
  /**
   * Caption labels in the document language (`documentTexts().captionLabels`)
   * for `tables.captionLabel` / `blocks.figureLabel`. Absent = English.
   */
  captionLabels?: { table: string, figure: string, separator: string, chapter?: { before: string, after: string } }
  /**
   * The document's custom CSS AFTER `sanitizeCustomCss` (shared/utils/theme/customCss.ts).
   * Appended last so user rules override the theme. Typed as the
   * sanitizer's result (not a bare string) so a call site can't hand the
   * raw `theme.customCss` through by accident — `theme.customCss` itself
   * is never read here.
   */
  customCss?: CustomCssResult
  /**
   * Maps a header/footer image URL (already shape-checked, see
   * `shared/utils/theme/themeImages.ts`) to the URL the page actually loads.
   * The server render page uses it to add its file-access token to this
   * document's own uploads; everyone else loads the URL as stored.
   */
  imageUrl?: (url: string) => string
}
