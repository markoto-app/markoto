import type MarkdownIt from 'markdown-it'
import type StateCore from 'markdown-it/lib/rules_core/state_core.mjs'
import type Token from 'markdown-it/lib/token.mjs'

/**
 * Two table rules for printed pages (registered by `renderMarkdown`).
 *
 * **Captions (Pandoc syntax).** A paragraph that starts with `Table:` (or
 * `table:`, or just `:`) directly before or after a table is the table's
 * caption — Pandoc's `table_captions` extension:
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
 * (`white-space: nowrap` in the theme). Only short, fixed patterns —
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

function addCaptions(state: StateCore): void {
  const tokens = state.tokens
  for (let i = 0; i < tokens.length; i++) {
    const tableOpen = tokens[i]
    if (tableOpen?.type !== 'table_open') continue
    const close = closeIndex(tokens, i)
    if (close < 0) continue
    const rowText = takeCaptionRow(tokens, i, close)
    if (rowText !== null) {
      const inline = new state.Token('inline', '', 0)
      inline.content = rowText
      inline.children = []
      insertCaption(state, tokens, i, inline)
      continue
    }
    // After the table first, then the paragraph right before it.
    let paraOpen = close + 1
    let text = captionText(tokens, paraOpen)
    if (text === null && i >= 3) {
      paraOpen = i - 3
      text = captionText(tokens, paraOpen)
    }
    if (text === null) continue
    const inline = tokens[paraOpen + 1]
    if (!inline) continue
    inline.content = text
    if (paraOpen > i) {
      tokens.splice(paraOpen, 3)
      insertCaption(state, tokens, i, inline)
    } else {
      insertCaption(state, tokens, i, inline)
      tokens.splice(paraOpen, 3)
      i -= 3
    }
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
/** Pairs that must not break: [comparison] [currency] number [unit], or a short code like SEV-1. */
const NOWRAP_RE = new RegExp(
  String.raw`(?<![\p{L}\p{N}])(?:(?:[<>≤≥~≈]=?${SPACE})?(?:(?:CHF|EUR|USD|GBP|JPY|Fr\.|[€$£¥])${SPACE})?${NUMBER}(?:${SPACE}(?:${UNIT_RE}))?(?![\p{L}\p{N}])|[A-Z][A-Za-z]{0,7}-\d{1,4}[a-z]?(?![\p{L}\p{N}-]))`,
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
    const at = m.index ?? 0
    if (at > last) runs.push({ text: text.slice(last, at), nowrap: false })
    runs.push({ text: s, nowrap: true })
    last = at + s.length
  }
  if (last < text.length) runs.push({ text: text.slice(last), nowrap: false })
  return runs
}

function wrapCellText(state: StateCore): void {
  let inCell = false
  for (const token of state.tokens) {
    if (token.type === 'td_open' || token.type === 'th_open') inCell = true
    else if (token.type === 'td_close' || token.type === 'th_close') inCell = false
    else if (inCell && token.type === 'inline' && token.children) {
      const out: Token[] = []
      for (const child of token.children) {
        if (child.type !== 'text') {
          out.push(child)
          continue
        }
        const runs = nowrapRuns(child.content)
        if (!runs.some(r => r.nowrap)) {
          out.push(child)
          continue
        }
        for (const run of runs) {
          const text = new state.Token('text', '', 0)
          text.content = run.text
          if (!run.nowrap) {
            out.push(text)
            continue
          }
          const open = new state.Token('markoto_nowrap_open', 'span', 1)
          open.attrSet('class', 'markoto-nowrap')
          out.push(open, text, new state.Token('markoto_nowrap_close', 'span', -1))
        }
      }
      token.children = out
    }
  }
}

export function tablePlugin(md: MarkdownIt): void {
  md.core.ruler.after('block', 'table_caption', addCaptions)
  md.core.ruler.push('table_cell_nowrap', wrapCellText)
}
