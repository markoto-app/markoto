import type MarkdownIt from 'markdown-it'
import type StateCore from 'markdown-it/lib/rules_core/state_core.mjs'
import type Token from 'markdown-it/lib/token.mjs'

/**
 * `{.class}` on the line right after a table.
 *
 * `@mdit/plugin-attrs` reads table attributes from a paragraph that
 * follows the table (`| … |` + blank line + `{.financials}`). Written on
 * the very next line, the natural way, GFM table parsing swallows the
 * line as one more body row, and the attributes land on an empty cell.
 * This core rule (after block parsing, before inline parsing and before
 * the attrs plugin runs) turns such a trailing row, first cell exactly
 * `{…}`, every other cell empty, back into that paragraph, so both
 * spellings give `<table class="financials">`.
 */

const ATTRS_ONLY = /^\{[^{}\n]+\}$/

/** Index of the matching `*_close` token for the `*_open` at `start`. */
function closeIndex(tokens: Token[], start: number, type: string): number {
  for (let i = start + 1; i < tokens.length; i++) {
    if (tokens[i]?.type === type) return i
  }
  return -1
}

/** Index of the last `tr_open` between `tbodyOpen` and `tbodyClose`, or -1. */
function lastRowOpen(tokens: Token[], tbodyOpen: number, tbodyClose: number): number {
  for (let j = tbodyClose - 1; j > tbodyOpen; j--) {
    if (tokens[j]?.type === 'tr_open') return j
  }
  return -1
}

/** The `{…}` of a row whose first cell holds only attributes and whose other cells are empty, else null. */
function attrsOnlyRow(tokens: Token[], trOpen: number, trClose: number): string | null {
  const cells = tokens.slice(trOpen, trClose + 1).filter(t => t.type === 'inline').map(t => t.content.trim())
  const [first, ...rest] = cells
  if (first === undefined || !ATTRS_ONLY.test(first) || rest.some(c => c !== '')) return null
  return first
}

/**
 * Moves the attributes row of the table body opening at `i` into a paragraph
 * after the table. Returns where the scan resumes (the removed row's old end),
 * or null when the body has no such row.
 */
function rewriteTableAt(state: StateCore, i: number): number | null {
  const tokens = state.tokens
  const tbodyClose = closeIndex(tokens, i, 'tbody_close')
  if (tbodyClose < 0) return null
  const trOpen = lastRowOpen(tokens, i, tbodyClose)
  if (trOpen < 0 || trOpen === i + 1) return null // no row, or the only row
  const trClose = closeIndex(tokens, trOpen, 'tr_close')
  const attrs = attrsOnlyRow(tokens, trOpen, trClose)
  if (attrs === null) return null
  const tableClose = closeIndex(tokens, tbodyClose, 'table_close')
  if (tableClose < 0) return null

  const pOpen = new state.Token('paragraph_open', 'p', 1)
  const inline = new state.Token('inline', '', 0)
  inline.content = attrs
  inline.children = []
  const pClose = new state.Token('paragraph_close', 'p', -1)
  const level = tokens[tableClose]?.level ?? 0
  pOpen.level = level
  inline.level = level + 1
  pClose.level = level
  tokens.splice(tableClose + 1, 0, pOpen, inline, pClose)
  tokens.splice(trOpen, trClose - trOpen + 1)
  return tableClose - (trClose - trOpen + 1) + 1
}

function rewriteTables(state: StateCore): void {
  const tokens = state.tokens
  // After a rewrite the scan resumes where the removed row used to end, so
  // the cursor is advanced here rather than by the loop header.
  let next = 0
  while (next < tokens.length) {
    const i = next++
    if (tokens[i]?.type !== 'tbody_open') continue
    next = rewriteTableAt(state, i) ?? next
  }
}

export function tableAttrsRowPlugin(md: MarkdownIt): void {
  md.core.ruler.after('block', 'table_attrs_row', (state: StateCore) => {
    rewriteTables(state)
  })
}
