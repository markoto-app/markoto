import type { DocTheme } from '../types/theme'
import { referenceStyle, resolveCaptions } from '../utils/theme/themeOptions'
import { cssString, cssFontStack } from './cssValues'
import type { ThemeRuntime } from './runtime'

// Table and figure captions (position, numbered labels) and the reference
// list.

/**
 * Table captions (`Table: …` / `: …` next to a table in the Markdown →
 * `<caption>`, renderMarkdown `tableCaptionPlugin`) in the figure-caption
 * voice, above or below the table (`tables.captionPosition`; for `below`
 * `composeFinalHtml` moves the caption to the end of the table, so a
 * table split across pages shows it under its last part). Optional
 * "Table 1: " / "Figure 1: " labels in the document language
 * (`tables.captionLabel`, `blocks.figureLabel`); only captioned tables and
 * figures count. Template CSS can restyle the label through `::before`
 * and the counters `mk-table` / `mk-figure`.
 */
export function captionBlock(theme: DocTheme, runtime: ThemeRuntime): string {
  const { tablePosition, tableLabel, figureLabel, numbering, labelStyle } = resolveCaptions(theme)
  const labels = runtime.captionLabels ?? { table: 'Table', figure: 'Figure', separator: ': ' }
  const side = tablePosition === 'below' ? 'bottom' : 'top'
  const space = tablePosition === 'below' ? 'padding-top' : 'padding-bottom'
  const rules = [
    `.paged-doc table > caption {
  caption-side: ${side};
  ${space}: 0.4em;
  font-family: ${cssFontStack(theme.meta.font)};
  font-size: 0.85em;
  font-style: italic;
  color: var(--doc-secondary);
  text-align: center;
}`
  ]
  // `blocks.captionNumbering: 'chapter'`: "3.1" from the number
  // `composeFinalHtml` writes on the caption (captionNumbers.ts), CSS
  // counters can't reset per section level the document happens to use.
  const number = (counter: string) => numbering === 'chapter' ? `attr(${CAPTION_NUMBER_ATTR})` : `counter(${counter})`
  // `blocks.captionLabelStyle: 'stacked'`: a bold upright label on its own
  // line, the title under it without separator (APA). The label is in the
  // text colour: the bold cut of a light caption colour (the default
  // caption is `--doc-secondary`, small, often in a mono face) read as a
  // light weight.
  const stacked = labelStyle === 'stacked'
  const separator = stacked ? '' : ` ${cssString(labels.separator)}`
  const stackedLook = stacked ? ' display: block; font-style: normal; font-weight: 700; color: var(--doc-text);' : ''
  if (tableLabel) {
    rules.push(`.paged-doc table > caption { counter-increment: mk-table; }
.paged-doc table > caption::before { content: ${cssString(`${labels.table} `)} ${number('mk-table')}${separator};${stackedLook} }`)
  }
  if (figureLabel) {
    rules.push(`.paged-doc figcaption:not(:empty) { counter-increment: mk-figure; }
.paged-doc figcaption:not(:empty)::before { content: ${cssString(`${labels.figure} `)} ${number('mk-figure')}${separator};${stackedLook} }`)
  }
  return rules.join('\n')
}

/** Attribute with a caption's chapter-relative number ("3.1"), written by `app/utils/markdown/captionNumbers.ts`. */
export const CAPTION_NUMBER_ATTR = 'data-markoto-number'

/**
 * The reference list: `composeFinalHtml` marks the lists and paragraphs of
 * the section headed References / Bibliography / Literatur / Références …
 * `markoto-references` (`app/utils/markdown/references.ts`), so the look survives a
 * list continued on the next page or column. `blocks.referenceStyle`:
 * `hanging` indents every line but the first; `brackets` labels numbered
 * lists `[1]`, `[2]` (and hangs paragraphs and bullet entries). The indent
 * is `--doc-reference-indent` (template CSS can set it).
 */
export function referencesBlock(theme: DocTheme): string {
  const style = referenceStyle(theme)
  if (style === 'plain') return ''
  const indent = 'var(--doc-reference-indent, 1.5em)'
  const rules = [
    `.paged-doc p.markoto-references { padding-left: ${indent}; text-indent: calc(-1 * ${indent}); }`,
    `.paged-doc ul.markoto-references { list-style: none; padding-left: ${indent}; }
.paged-doc ul.markoto-references > li { text-indent: calc(-1 * ${indent}); }`
  ]
  if (style === 'brackets') {
    rules.push(`.paged-doc ol.markoto-references { padding-left: 2.4em; }
.paged-doc ol.markoto-references > li::marker { content: "[" counter(list-item) "]\\2002"; font-variant-numeric: lining-nums tabular-nums; }`)
  }
  return rules.join('\n')
}
