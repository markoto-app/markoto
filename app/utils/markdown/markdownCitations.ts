import type { MarkdownIt, StateBlock, StateInline, StateCore, Token } from 'markdown-it'
import { bareCiteAllowedAfter, parseBracketCluster, parseSuffix, readKey, type CiteRef } from '~~/shared/utils/citations/citeSyntax'

/**
 * Parsing side of citations and cross-references (the DOM side that turns
 * them into text is `app/utils/markdown/citationResolve.ts`, run by
 * `composeFinalHtml` with the document's bibliography, style and language).
 *
 *   - `[@key, p. 3; @other]`, `[-@key]`, `@key`, `@key [p. 3]` and the
 *     cross-references `@fig:x` / `[@tbl:y]` become
 *     `<span class="markoto-cite" data-cite="…">original text</span>`.
 *     The span keeps the source text so an unresolved bare `@word` (not a
 *     bibliography key, not a label) prints exactly as written.
 *   - `[[bibliography]]`, `[[lof]]`, `[[lot]]` on a line of their own
 *     become empty placeholders the resolver fills.
 *   - `$$ … $$ {#eq:label}` (single line, or the closing `$$` line carrying
 *     the label) becomes a labelled equation: the math block wrapped in
 *     `div.markoto-equation`, the resolver numbers it.
 *
 * Everything is emitted through renderer rules that escape their text;
 * `data-cite` is JSON the resolver re-validates (an author could write the
 * same attribute by hand with `{data-cite=…}`).
 */

export const CITE_CLASS = 'markoto-cite'
export const BIBLIOGRAPHY_SLOT_CLASS = 'markoto-bibliography-slot'
export const LIST_SLOT_CLASS = 'markoto-list-slot'
export const EQUATION_CLASS = 'markoto-equation'

export interface CiteData {
  refs: CiteRef[]
  /** `[…]` cluster (parenthetical) vs a bare `@key` in the text (narrative). */
  bracketed: boolean
}

function citeToken(state: StateInline, data: CiteData, raw: string): void {
  const token = state.push('markoto_cite', 'span', 0)
  token.meta = { cite: data }
  token.content = raw
}

/** Index of the `]` closing the `[` at `start` (no nesting, single line), or -1. */
function closingBracket(src: string, start: number, max: number): number {
  for (let i = start + 1; i < max; i++) {
    const ch = src.charCodeAt(i)
    if (ch === 0x5D /* ] */) return i
    if (ch === 0x5B /* [ */ || ch === 0x0A) return -1
    if (ch === 0x5C /* \ */) i++
  }
  return -1
}

function bracketCitation(state: StateInline, silent: boolean): boolean {
  const start = state.pos
  if (state.src.charCodeAt(start) !== 0x5B /* [ */) return false
  // `[^1]` footnotes, `[ ]` task boxes are other rules'.
  if (state.src.charCodeAt(start + 1) === 0x5E /* ^ */) return false
  const end = closingBracket(state.src, start, state.posMax)
  if (end < 0) return false
  // `[text](url)`, `[text][ref]`, `[text]{.attrs}` are links / spans.
  const next = state.src.charCodeAt(end + 1)
  if (next === 0x28 /* ( */ || next === 0x5B /* [ */ || next === 0x7B /* { */) return false
  const refs = parseBracketCluster(state.src.slice(start + 1, end))
  if (!refs) return false
  if (!silent) citeToken(state, { refs, bracketed: true }, state.src.slice(start, end + 1))
  state.pos = end + 1
  return true
}

function bareCitation(state: StateInline, silent: boolean): boolean {
  const start = state.pos
  if (state.src.charCodeAt(start) !== 0x40 /* @ */) return false
  if (!bareCiteAllowedAfter(start > 0 ? state.src[start - 1] : undefined)) return false
  const key = readKey(state.src.slice(start + 1, Math.min(state.posMax, start + 120)))
  if (!key) return false
  let end = start + 1 + key.length
  // `@key [p. 33]`: a locator for a narrative citation.
  let suffix = ''
  const after = /^ \[([^\]@[\n]{1,200})\](?![([{])/.exec(state.src.slice(end, Math.min(state.posMax, end + 210)))
  if (after) {
    suffix = after[1] ?? ''
    end += after[0].length
  }
  if (!silent) {
    const { locator, suffix: rest } = parseSuffix(suffix)
    const ref: CiteRef = { key, prefix: '', suffix: rest, ...(locator ? { locator } : {}), suppressAuthor: false }
    citeToken(state, { refs: [ref], bracketed: false }, state.src.slice(start, end))
  }
  state.pos = end
  return true
}

/** `[[bibliography]]` / `[[lof]]` / `[[lot]]` on a line of their own. */
function slotRule(state: StateBlock, startLine: number, _endLine: number, silent: boolean): boolean {
  const start = (state.bMarks[startLine] ?? 0) + (state.tShift[startLine] ?? 0)
  const max = state.eMarks[startLine] ?? 0
  const m = /^\[\[(bibliography|lof|lot)\]\]\s*$/i.exec(state.src.slice(start, max))
  if (!m) return false
  if (silent) return true
  const kind = (m[1] ?? '').toLowerCase()
  const token = state.push('html_block', '', 0)
  // Controlled markup only (see the html_block note in app/utils/AGENTS.md).
  token.content = kind === 'bibliography'
    ? `<div class="${BIBLIOGRAPHY_SLOT_CLASS}"></div>\n`
    : `<nav class="${LIST_SLOT_CLASS}" data-markoto-list="${kind}"></nav>\n`
  token.map = [startLine, startLine + 1]
  state.line = startLine + 1
  return true
}

const LABEL_RE = /^(?:eq|tbl):[\p{L}\p{N}_:.-]+$/u

/**
 * A `{#eq:x}` / `{#tbl:x}` label at the end of `text` (trailing spaces
 * allowed): the label and the text before it (right-trimmed), or null.
 */
function trailingLabel(text: string, kind: 'eq' | 'tbl'): { label: string, before: string } | null {
  const t = text.trimEnd()
  if (!t.endsWith('}')) return null
  const open = t.lastIndexOf('{#')
  if (open < 0) return null
  const label = t.slice(open + 2, -1)
  if (!LABEL_RE.test(label) || !label.startsWith(`${kind}:`)) return null
  return { label, before: t.slice(0, open).trimEnd() }
}

interface LabelledMath { label: string, content: string, last: number }

/** `$$ x $$ {#eq:a}` on one line. */
function singleLineEquation(firstLine: string, startLine: number): LabelledMath | null {
  const found = trailingLabel(firstLine, 'eq')
  if (!found?.before.endsWith('$$') || found.before.length <= 4) return null
  return { label: found.label, content: `${found.before.slice(2, -2).trim()}\n`, last: startLine }
}

function lineText(state: StateBlock, line: number): string {
  const ls = (state.bMarks[line] ?? 0) + (state.tShift[line] ?? 0)
  return state.src.slice(ls, state.eMarks[line] ?? 0)
}

/** `$$`, lines, `$$ {#eq:a}`: the closing line carries the label. */
function multiLineEquation(state: StateBlock, firstLine: string, startLine: number, endLine: number): LabelledMath | null {
  if (firstLine.slice(2).includes('$$')) return null
  const lines: string[] = [firstLine.slice(2)]
  for (let line = startLine + 1; line < endLine; line++) {
    const text = lineText(state, line)
    if (!text.includes('$$')) {
      lines.push(text)
      continue
    }
    const found = trailingLabel(text, 'eq')
    if (!found?.before.endsWith('$$')) return null
    lines.push(found.before.slice(0, -2))
    const kept = lines.map(l => l.trimEnd()).filter((l, i, a) => l !== '' || (i > 0 && i < a.length - 1))
    return { label: found.label, content: `${kept.join('\n').trim()}\n`, last: line }
  }
  return null
}

/**
 * Labelled display math: the math block rule of @mdit/plugin-tex needs the
 * closing `$$` alone on its line, so a block ending in `$$ {#eq:x}` is
 * taken here: math_block token (rendered by the KaTeX plugin as usual)
 * between `equation_open` / `equation_close`.
 */
function labelledEquation(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  if ((state.sCount[startLine] ?? 0) - state.blkIndent >= 4) return false
  const firstLine = lineText(state, startLine)
  if (!firstLine.startsWith('$$')) return false
  const eq = singleLineEquation(firstLine, startLine) ?? multiLineEquation(state, firstLine, startLine, endLine)
  if (!eq) return false
  if (silent) return true
  const open = state.push('equation_open', 'div', 1)
  open.attrSet('class', EQUATION_CLASS)
  open.attrSet('id', eq.label)
  open.map = [startLine, eq.last + 1]
  const math = state.push('math_block', 'math', 0)
  math.block = true
  math.content = eq.content
  math.markup = '$$'
  math.map = [startLine, eq.last + 1]
  state.push('equation_close', 'div', -1)
  state.line = eq.last + 1
  return true
}

/**
 * `Table: Results {#tbl:results}`: a label at the end of a table caption
 * moves to the table (runs after the caption rule, before inline parsing).
 */
function tableCaptionLabels(state: StateCore): void {
  const tokens = state.tokens
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i]?.type !== 'caption_open') continue
    const inline: Token | undefined = tokens[i + 1]
    if (inline?.type !== 'inline') continue
    const found = trailingLabel(inline.content, 'tbl')
    if (!found) continue
    inline.content = found.before
    tableOpenBefore(tokens, i)?.attrSet('id', found.label)
  }
}

/** The `table_open` token before index `i`. */
function tableOpenBefore(tokens: Token[], i: number): Token | undefined {
  for (let j = i - 1; j >= 0; j--) {
    if (tokens[j]?.type === 'table_open') return tokens[j]
  }
  return undefined
}

/** Attribute carrying a heading's `{#sec:…}` label (its id stays the slug the TOC links to). */
export const LABEL_ATTR = 'data-markoto-label'

/**
 * `# Methods {#sec:methods}`: the label moves to `data-markoto-label`, so
 * markdown-it-anchor gives the heading the same slug id the TOC links to
 * (it would keep `sec:methods` as the id while the TOC points at
 * `#methods`). Runs after the attrs plugin, before anchor.
 */
function headingLabels(state: StateCore): void {
  for (const token of state.tokens) {
    if (token.type !== 'heading_open') continue
    const id = token.attrGet('id')
    if (typeof id !== 'string' || !/^sec:./.test(id)) continue
    token.attrs = (token.attrs ?? []).filter(([name]) => name !== 'id')
    token.attrSet(LABEL_ATTR, id)
  }
}

export function citationsPlugin(md: MarkdownIt): void {
  md.core.ruler.after('attrs', 'markoto_heading_label', headingLabels)
  md.inline.ruler.before('link', 'markoto_cite_bracket', bracketCitation)
  md.inline.ruler.before('text', 'markoto_cite_bare', bareCitation)
  md.block.ruler.before('paragraph', 'markoto_slot', slotRule)
  md.block.ruler.before('math_block_dollar', 'markoto_equation', labelledEquation, { alt: ['paragraph', 'reference', 'blockquote', 'list'] })
  md.core.ruler.after('table_caption', 'markoto_table_label', tableCaptionLabels)
  md.renderer.rules.markoto_cite = (tokens, idx) => {
    const token = tokens[idx]
    if (!token) return ''
    const data = md.utils.escapeHtml(JSON.stringify((token.meta as { cite?: CiteData } | null)?.cite ?? null))
    return `<span class="${CITE_CLASS}" data-cite="${data}">${md.utils.escapeHtml(token.content)}</span>`
  }
}
