import type MarkdownIt from 'markdown-it'
import type StateCore from 'markdown-it/lib/rules_core/state_core.mjs'
import type Token from 'markdown-it/lib/token.mjs'

/**
 * Two table rules for printed pages (registered by `renderMarkdown`).
 *
 * **Captions (Pandoc syntax).** A paragraph that starts with `Table:` (or
 * `table:`, or just `:`) directly before or after a table is the table's
 * caption: Pandoc's `table_captions` extension:
 *
 *     | Metric | Q3 |
 *     |---|--:|
 *     | Revenue | 48.6 |
 *
 *     Table: Key figures (CHF million)
 *
 * It becomes a real `<caption>` (first child of the table; the theme puts
 * it above or below, `tables.captionPosition`, and can number it). A
 * paragraph after the table wins over one before it, so `table, caption,
 * table` gives the caption to the first table. Runs after block parsing
 * and before inline parsing: the caption text is parsed as inline
 * Markdown like any paragraph.
 *
 * **Number + unit stay together in cells.** In a narrow column the
 * browser may break "+8.1 %" after the number and "SEV-1" after the
 * hyphen. Inside table cells, a number with its unit or `%`, a currency
 * with its amount, a comparison sign with its number and short codes
 * like `SEV-1` / `ISO-8601` are wrapped in `<span class="markoto-nowrap">`
 * (`white-space: nowrap` in the theme). Only short, fixed patterns,
 * long cell text still wraps, so wide tables keep fitting the page.
 */

const CAPTION_PREFIX = /^(?:[Tt]able:|:)[ \t]+(?=\S)/

function isParagraphAt(tokens: Token[], open: number): boolean {
  return tokens[open]?.type === 'paragraph_open'
    && tokens[open + 1]?.type === 'inline'
    && tokens[open + 2]?.type === 'paragraph_close'
}

function captionText(tokens: Token[], open: number): string | null {
  if (!isParagraphAt(tokens, open)) return null
  const content = tokens[open + 1]?.content ?? ''
  return CAPTION_PREFIX.test(content) ? content.replace(CAPTION_PREFIX, '') : null
}

function closeIndex(tokens: Token[], start: number, type = 'table_close'): number {
  for (let i = start + 1; i < tokens.length; i++) {
    if (tokens[i]?.type === type) return i
  }
  return -1
}

/**
 * A caption written on the line right under the table (no blank line):
 * GFM parsing makes it one more body row (first cell `Table: …`, the
 * others empty). Take that row out and return its text, else null.
 */
function takeCaptionRow(tokens: Token[], tableOpen: number, tableClose: number): string | null {
  const tbodyClose = closeIndex(tokens, tableOpen, 'tbody_close')
  if (tbodyClose < 0 || tbodyClose > tableClose) return null
  let trOpen = -1
  let rows = 0
  for (let j = tbodyClose - 1; j > tableOpen; j--) {
    if (tokens[j]?.type === 'tbody_open') break
    if (tokens[j]?.type === 'tr_open') {
      rows++
      if (trOpen < 0) trOpen = j
    }
  }
  if (trOpen < 0 || rows < 2) return null // keep a table's only row
  const trClose = closeIndex(tokens, trOpen, 'tr_close')
  const [first, ...rest] = tokens.slice(trOpen, trClose + 1).filter(t => t.type === 'inline').map(t => t.content.trim())
  if (first === undefined || !CAPTION_PREFIX.test(first) || rest.some(c => c !== '')) return null
  tokens.splice(trOpen, trClose - trOpen + 1)
  return first.replace(CAPTION_PREFIX, '')
}

/** The caption paragraph of the table opening at `i`: after the table first, then the paragraph right before it. */
function captionParagraph(tokens: Token[], i: number, close: number): { open: number, text: string } | null {
  const after = captionText(tokens, close + 1)
  if (after !== null) return { open: close + 1, text: after }
  const before = i >= 3 ? captionText(tokens, i - 3) : null
  return before === null ? null : { open: i - 3, text: before }
}

/** Gives the table opening at `i` its caption; returns how many tokens before `i` were removed. */
function captionTable(state: StateCore, i: number): number {
  const tokens = state.tokens
  const close = closeIndex(tokens, i)
  if (close < 0) return 0
  const rowText = takeCaptionRow(tokens, i, close)
  if (rowText !== null) {
    const inline = new state.Token('inline', '', 0)
    inline.content = rowText
    inline.children = []
    insertCaption(state, tokens, i, inline)
    return 0
  }
  const para = captionParagraph(tokens, i, close)
  const inline = para ? tokens[para.open + 1] : undefined
  if (!para || !inline) return 0
  inline.content = para.text
  if (para.open > i) {
    tokens.splice(para.open, 3)
    insertCaption(state, tokens, i, inline)
    return 0
  }
  insertCaption(state, tokens, i, inline)
  tokens.splice(para.open, 3)
  return 3
}

function addCaptions(state: StateCore): void {
  for (let i = 0; i < state.tokens.length; i++) {
    if (state.tokens[i]?.type === 'table_open') i -= captionTable(state, i)
  }
}

/** `<caption>` with `inline` as its content, as the first child of the table at `tableOpen`. */
function insertCaption(state: StateCore, tokens: Token[], tableOpen: number, inline: Token): void {
  const level = tokens[tableOpen]?.level ?? 0
  const open = new state.Token('caption_open', 'caption', 1)
  open.block = true
  open.level = level + 1
  inline.level = level + 2
  const shut = new state.Token('caption_close', 'caption', -1)
  shut.block = true
  shut.level = level + 1
  tokens.splice(tableOpen + 1, 0, open, inline, shut)
}

const UNITS = [
  '%', '‰', '‱', 'pp', 'bp', 'bps', '°C', '°F', '°',
  'B', 'kB', 'KB', 'MB', 'GB', 'TB', 'PB', 'KiB', 'MiB', 'GiB', 'TiB', 'bit', 'kbit', 'Mbit', 'Gbit',
  'ns', 'µs', 'μs', 'ms', 's', 'min', 'h', 'd', 'wk', 'mo', 'yr',
  'Hz', 'kHz', 'MHz', 'GHz', 'mm', 'cm', 'm', 'km', 'mg', 'g', 'kg', 't', 'ml', 'mL', 'l', 'L',
  'W', 'kW', 'MW', 'kWh', 'MWh', 'V', 'A', 'mA', 'px', 'pt', 'x', '×',
  'CHF', 'EUR', 'USD', 'GBP', '€', '$', '£', '¥', 'k', 'M', 'bn', 'Mio.', 'Mrd.'
]
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const UNIT_RE = [...UNITS].sort((a, b) => b.length - a.length).map(escapeRe).join('|')
const NUMBER = String.raw`[+\-−±]?\d+(?:[.,'’]\d+)*`
const SPACE = '[ \\u00A0\\u202F]'
/**
 * Month names and abbreviations (English, German, French, Spanish, the
 * document languages with Latin script) for dates like "30 Jan 2027".
 */
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December',
  'Jan', 'Feb', 'Mar', 'Apr', 'Jun', 'Jul', 'Aug', 'Sep', 'Sept', 'Oct', 'Nov', 'Dec',
  'Januar', 'Februar', 'März', 'Mai', 'Juni', 'Juli', 'Oktober', 'Dezember', 'Okt', 'Dez',
  'janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre',
  'janv', 'févr', 'avr', 'juil', 'sept', 'oct', 'nov', 'déc',
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
  'ene', 'abr', 'ago', 'dic'
]
const MONTH_RE = `(?:${[...new Set(MONTHS)].sort((a, b) => b.length - a.length).map(escapeRe).join('|')})\\.?`
const DAY = String.raw`\d{1,2}\.?`
const YEAR = String.raw`\d{4}`
/** "30 Jan 2027", "12. Januar", "Jan 12, 2027", "March 2027", "2027-01-30". */
const DATE = String.raw`(?:${DAY}${SPACE}(?:de${SPACE})?${MONTH_RE}(?:${SPACE}(?:de${SPACE})?${YEAR})?|${MONTH_RE}${SPACE}(?:${DAY},?${SPACE}${YEAR}|${DAY}|${YEAR})|${YEAR}-\d{2}-\d{2})(?![\p{L}\p{N}])`
/** A short hyphenated word ("on-call", "roll-out", "e-mail"): the browser would break after the hyphen. */
const COMPOUND = String.raw`(?<!-)\p{L}[\p{L}\p{N}]*(?:-[\p{L}\p{N}]+)+(?![\p{L}\p{N}-])`
/** A hyphenated word longer than this may still break at its hyphens (a narrow column must stay narrow). */
const COMPOUND_MAX_LENGTH = 16
/**
 * Runs that must not break: a date; [comparison] [currency] number [unit];
 * a short code like SEV-1; a short hyphenated word.
 */
const NOWRAP_RE = new RegExp(
  String.raw`(?<![\p{L}\p{N}])(?:${DATE}|(?:[<>≤≥~≈]=?${SPACE})?(?:(?:CHF|EUR|USD|GBP|JPY|Fr\.|[€$£¥])${SPACE})?${NUMBER}(?:${SPACE}(?:${UNIT_RE}))?(?![\p{L}\p{N}])|[A-Z][A-Za-z]{0,7}-\d{1,4}[a-z]?(?![\p{L}\p{N}-])|${COMPOUND})`,
  'gu'
)

/** Split one text token's content into plain and must-not-break runs. */
export function nowrapRuns(text: string): Array<{ text: string, nowrap: boolean }> {
  const runs: Array<{ text: string, nowrap: boolean }> = []
  let last = 0
  for (const m of text.matchAll(NOWRAP_RE)) {
    const s = m[0]
    // A lone number has nothing to keep together.
    if (!/[ \u00A0\u202F-]/u.test(s.replace(/^[+\-−±]/u, ''))) continue
    // A long hyphenated word keeps its break opportunities.
    if (/^\p{L}/u.test(s) && s.includes('-') && !s.includes(' ') && s.length > COMPOUND_MAX_LENGTH) continue
    const at = m.index ?? 0
    if (at > last) runs.push({ text: text.slice(last, at), nowrap: false })
    runs.push({ text: s, nowrap: true })
    last = at + s.length
  }
  if (last < text.length) runs.push({ text: text.slice(last), nowrap: false })
  return runs
}

/** `child` split into plain text and `<span class="markoto-nowrap">` runs. */
function nowrapTokens(state: StateCore, child: Token): Token[] {
  if (child.type !== 'text') return [child]
  const runs = nowrapRuns(child.content)
  if (!runs.some(r => r.nowrap)) return [child]
  return runs.flatMap((run) => {
    const text = new state.Token('text', '', 0)
    text.content = run.text
    if (!run.nowrap) return [text]
    const open = new state.Token('markoto_nowrap_open', 'span', 1)
    open.attrSet('class', 'markoto-nowrap')
    return [open, text, new state.Token('markoto_nowrap_close', 'span', -1)]
  })
}

function wrapCellText(state: StateCore): void {
  let inCell = false
  for (const token of state.tokens) {
    if (token.type === 'td_open' || token.type === 'th_open') inCell = true
    else if (token.type === 'td_close' || token.type === 'th_close') inCell = false
    else if (inCell && token.type === 'inline' && token.children) {
      token.children = token.children.flatMap(child => nowrapTokens(state, child))
    }
  }
}

export function tablePlugin(md: MarkdownIt): void {
  md.core.ruler.after('block', 'table_caption', addCaptions)
  md.core.ruler.push('table_cell_nowrap', wrapCellText)
}
