import type { DocTheme, HeadingNumbering } from '../types/theme'
import { headingNumbering, numberingDepth, resolveChapterLabel } from '../utils/theme/themeOptions'
import { cssString } from './cssValues'
import type { ThemeRuntime } from './runtime'

// Heading numbers (CSS counters) and the "Chapter N" label.

/**
 * Headings that never get a number (nor advance the counters): the cover /
 * title-block title, the abstract, and headings the author marked
 * `{.unnumbered}` / `{-}` (Pandoc convention — References, Acknowledgements).
 */
const UNNUMBERED = ':not(.markoto-cover-title):not(.markoto-abstract-heading):not(.unnumbered)'

/** TOC entries of those headings (marked by `app/utils/preview/titleBlock.ts`). */
const UNNUMBERED_TOC = ':not(.markoto-abstract-entry):not(.markoto-unnumbered-entry)'

/**
 * Heading numbers (`headings.numbering`) before h1–h4 and before the
 * matching TOC entries. Plain CSS counters: paged.js turns
 * `counter-increment` / `counter-reset` into per-element values, so
 * numbers continue across pages. h1 resets the levels below it and
 * nothing above. The TOC lists the same headings in the same order (the
 * abstract's and `{.unnumbered}` headings' entries are marked by
 * `markAbstract` / `markUnnumbered` and skipped), so its counters match
 * the headings'.
 *
 * Levels count from the highest heading level the document numbers: when
 * that is h2 (no h1), `composeFinalHtml` marks the numbered headings
 * `markoto-num-from-h2` and the h2 shows `1`, the h3 `1.1` — not `0.1`.
 * The TOC is relative already (markdown-it-toc-done-right nests from the
 * highest level used), so its depth is the logical level.
 */
export function numberingBlock(theme: DocTheme, runtime: ThemeRuntime): string {
  const style = headingNumbering(theme)
  if (style === 'none') return ''
  // `headings.numberingDepth`: how many levels (from the highest numbered
  // one) show a number. Every level still counts, so the numbers that do
  // show stay right.
  const depth = numberingDepth(theme)
  const levels = [1, 2, 3, 4]
  const name = (l: number) => `mk-h${l}`
  const tocName = (l: number) => `mk-toc${l}`
  const gap = style === 'ieee' ? '0.5em' : '0.75em'
  const rules: string[] = []
  for (const l of levels) {
    const below = levels.filter(i => i > l)
    const reset = below.length ? `\n  counter-reset: ${below.map(name).join(' ')};` : ''
    rules.push(`.paged-doc h${l}${UNNUMBERED} {
  counter-increment: ${name(l)};${reset}
}`)
    if (l <= depth) {
      rules.push(`.paged-doc h${l}${UNNUMBERED}::before {
  content: ${numberLabel(style, levels.slice(0, l).map(name))};
  margin-right: ${gap};
  font-variant-numeric: lining-nums tabular-nums;
}`)
    }
    const tocReset = below.length ? `\n  counter-reset: ${below.map(tocName).join(' ')};` : ''
    const li = `.paged-doc .table-of-contents > ${'ul > li > '.repeat(l - 1)}ul > li${UNNUMBERED_TOC}`
    rules.push(`${li} {
  counter-increment: ${tocName(l)};${tocReset}
}`)
    if (l <= depth) {
      rules.push(`${li}::before {
  content: ${numberLabel(style, levels.slice(0, l).map(tocName))};
  min-width: ${(1.2 + 0.6 * (l - 1)).toFixed(1)}em;
  margin-right: 0.5em;
  font-variant-numeric: lining-nums tabular-nums;
}`)
    }
  }
  // Documents whose highest numbered level is h2–h4: count from there.
  for (const base of [2, 3, 4]) {
    for (const l of levels.filter(i => i >= base && i - base < depth)) {
      const counters = levels.filter(i => i >= base && i <= l).map(name)
      rules.push(`.paged-doc h${l}.${numberingBaseClass(base)}${UNNUMBERED}::before { content: ${numberLabel(style, counters)}; }`)
    }
  }
  return [
    // Number + entry on one row; a nested list wraps below.
    `.paged-doc .table-of-contents li { display: flex; flex-wrap: wrap; align-items: baseline; }
.paged-doc .table-of-contents li > a { flex: 1 1 0; min-width: 0; }
.paged-doc .table-of-contents li > ul { flex-basis: 100%; }`,
    ...rules,
    chapterLabelBlock(theme, runtime)
  ].filter(Boolean).join('\n')
}

/**
 * `headings.chapterLabel`: "Chapter 3" (in the document language, or
 * `headings.chapterWord`) on a line of its own over every numbered
 * top-level section heading — the heading of the highest level used,
 * which is also the numbering base (`headingStructure.ts`). Replaces the
 * plain number there; the TOC keeps the number.
 */
function chapterLabelBlock(theme: DocTheme, runtime: ThemeRuntime): string {
  const chapter = resolveChapterLabel(theme)
  if (!chapter.enabled) return ''
  const style = headingNumbering(theme)
  if (style === 'none') return ''
  const words = chapter.word.trim()
    ? { before: `${chapter.word.trim()} `, after: '' }
    : runtime.captionLabels?.chapter ?? { before: 'Chapter ', after: '' }
  const fmt = style === 'ieee' ? 'upper-roman' : style === 'decimal-zero' ? 'decimal-leading-zero' : 'decimal'
  const label = (l: number) => [
    words.before ? cssString(words.before) : '',
    `counter(mk-h${l}, ${fmt})`,
    words.after ? cssString(words.after) : ''
  ].filter(Boolean).join(' ')
  const look = `display: block;
  margin: 0 0 0.35em;`
  const rules = [`.paged-doc h1.${SECTION_HEADING_CLASS}${UNNUMBERED}::before {
  content: ${label(1)};
  ${look}
}`]
  for (const base of [2, 3, 4]) {
    rules.push(`.paged-doc h${base}.${SECTION_HEADING_CLASS}.${numberingBaseClass(base)}${UNNUMBERED}::before {
  content: ${label(base)};
  ${look}
}`)
  }
  return rules.join('\n')
}

/** Class `composeFinalHtml` puts on every heading of the highest level the document uses (`headingStructure.ts`). */
export const SECTION_HEADING_CLASS = 'markoto-section-heading'

/** Class `composeFinalHtml` puts on numbered headings when the highest numbered level is h`base` (2–4). */
export function numberingBaseClass(base: number): string {
  return `markoto-num-from-h${base}`
}

/** IEEEtran's number per level: \Roman. / \Alph. / \arabic) / \alph). */
const IEEE_LEVEL_FORMATS = [['upper-roman', '.'], ['upper-alpha', '.'], ['decimal', ')'], ['lower-alpha', ')']] as const

/**
 * CSS `content` for the number of a heading whose counters (outermost
 * first) are `counters` — the last one is the heading's own level.
 */
function numberLabel(style: Exclude<HeadingNumbering, 'none'>, counters: string[]): string {
  if (style === 'ieee') {
    const own = counters.at(-1) ?? ''
    const [fmt, suffix] = IEEE_LEVEL_FORMATS[counters.length - 1] ?? IEEE_LEVEL_FORMATS[3]
    return `counter(${own}, ${fmt}) "${suffix}"`
  }
  // `decimal-zero`: the top level two-digit (`01`), the levels below plain (`01.2`).
  const joined = counters.map((c, i) => style === 'decimal-zero' && i === 0 ? `counter(${c}, decimal-leading-zero)` : `counter(${c})`).join(' "." ')
  return style === 'decimal-dot' ? `${joined} "."` : joined
}
