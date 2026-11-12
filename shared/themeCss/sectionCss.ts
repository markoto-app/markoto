import type { DocTheme } from '../types/theme'
import { resolveSectionToken } from '../utils/theme/themeOptions'

// The running section title behind the `{section}` header/footer token.

/** Named string behind the `{section}` header/footer token. */
export const SECTION_STRING = 'mk-section'

/**
 * `{section}`: paged.js `string-set` on the document's top-level section
 * headings (`markoto-section-heading`, marked by `composeFinalHtml`, h1,
 * or h2 in a document without h1). The token reads the first one that
 * starts on the page, else the one running on from before. Only emitted
 * when a header/footer slot uses the token.
 */
export function sectionStringBlock(theme: DocTheme): string {
  const slots = [theme.header, theme.footer].flatMap(s => [s.left, s.center, s.right])
  if (!slots.some(t => t.includes('{section}'))) return ''
  // paged.js 0.4.3 reads `content()` (the text, without the CSS number)
  // and `attr()` only. With `header.sectionNumber` the heading carries
  // "3 Procedures" in `data-markoto-section` (headingStructure.ts).
  const value = resolveSectionToken(theme).number ? `attr(${SECTION_LABEL_ATTR})` : 'content(text)'
  return `.paged-doc .markoto-section-heading { string-set: ${SECTION_STRING} ${value}; }`
}

/** Attribute with the section number + title, set on every top-level section heading when `header.sectionNumber` is on. */
export const SECTION_LABEL_ATTR = 'data-markoto-section'
