// Line-numbered views of the document text, shared by the read/edit tools
// and the comment tools (line ranges → character offsets).

export function withLineNumbers(text: string, startLine: number = 1): string {
  const lines = text.split('\n')
  return lines.map((line, i) => `${startLine + i}: ${line}`).join('\n')
}

export function findIndexOfOnlyMatch(haystack: string, needle: string): { found: number, count: number } {
  if (needle.length === 0) return { found: -1, count: 0 }
  let count = 0
  let first = -1
  let i = 0
  while (true) {
    const pos = haystack.indexOf(needle, i)
    if (pos === -1) break
    if (count === 0) first = pos
    count += 1
    i = pos + needle.length
  }
  return { found: count === 1 ? first : -1, count }
}

/** Lines shown back to the model after an edit (plus one line of context on each side). */
const EDIT_ECHO_MAX_LINES = 24
const EDIT_ECHO_MAX_CHARS = 2400

/**
 * Show the model the lines its edit produced, numbered like
 * `view_document`, with one line of context around them. Without it the
 * model never saw the result (blank lines in particular) and kept
 * re-editing the same spot.
 */
export function describeEditedRegion(full: string, start: number, length: number): string {
  const lines = full.split('\n')
  const firstLine = full.slice(0, start).split('\n').length
  const insertedNewlines = full.slice(start, start + length).split('\n').length - 1
  // An insertion that ends with a newline ends on the line before.
  const endsWithNewline = length > 0 && full[start + length - 1] === '\n'
  const lastLine = Math.max(firstLine, firstLine + insertedNewlines - (endsWithNewline ? 1 : 0))
  if (length === 0) return `The text at line ${firstLine} was removed.`
  const from = Math.max(1, firstLine - 1)
  const to = Math.min(lines.length, lastLine + 1)
  const span = firstLine === lastLine ? `Line ${firstLine} now reads` : `Lines ${firstLine}-${lastLine} now read`
  if (lastLine - firstLine + 1 > EDIT_ECHO_MAX_LINES) {
    return `Lines ${firstLine}-${lastLine} now hold the new text (${lastLine - firstLine + 1} lines; call view_document to read it).`
  }
  let echo = withLineNumbers(lines.slice(from - 1, to).join('\n'), from)
  if (echo.length > EDIT_ECHO_MAX_CHARS) echo = echo.slice(0, EDIT_ECHO_MAX_CHARS) + '\n[truncated]'
  return `${span} (with one line of context on each side):\n${echo}`
}

/**
 * Resolve a 1-indexed "insert after line N" into a character offset
 * into `full`. Returns null if the line is beyond EOF.
 *
 * - insert_line=0 → 0 (beginning of file)
 * - insert_line=N → start of line N+1
 * - insert_line === lines.length → end of file
 *
 * The +1-per-newline tally overshoots when the doc has no trailing
 * newline and we're appending; `Math.min(idx, full.length)` clamps us
 * back. Mid-doc positions never exceed total length, so they're
 * unaffected.
 */
export function lineToCharOffset(full: string, insertLine: number): number | null {
  const lines = full.split('\n')
  if (insertLine > lines.length) return null
  let idx = 0
  for (const line of lines.slice(0, insertLine)) {
    idx += line.length + 1
  }
  return Math.min(idx, full.length)
}

// Lines that may follow each other without a blank line: list items, table
// rows, quote lines. A blank line between two list items would turn a
// tight list into a loose one.
const LIST_ITEM_RE = /^([-*+]|\d{1,9}[.)])(\s|$)/
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/

function lineKind(line: string): 'list' | 'table' | 'quote' | 'other' {
  if (LIST_ITEM_RE.test(line)) return 'list'
  if (line.startsWith('|')) return 'table'
  if (line.startsWith('>')) return 'quote'
  return 'other'
}

/**
 * Whether two adjacent lines belong to different blocks that need a blank
 * line between them. Indented lines (nested lists, continuation lines,
 * indented code) are left alone, as are lines of the same list, table or
 * quote.
 */
function needsBlankLineBetween(above: string, below: string): boolean {
  if (above.trim() === '' || below.trim() === '') return false
  if (/^\s/.test(above) || /^\s/.test(below)) return false
  const kind = lineKind(above)
  return kind === 'other' || kind !== lineKind(below)
}

/** Whether `before` (text from the start of the document) ends inside a fenced code block. */
function endsInsideCodeFence(before: string): boolean {
  let open: string | null = null
  for (const line of before.split('\n')) {
    const fence = FENCE_RE.exec(line)?.[1]
    if (!fence) continue
    if (open === null) open = fence
    else if (fence[0] === open[0] && fence.length >= open.length) open = null
  }
  return open !== null
}

/**
 * The text `insert_text` writes at character offset `idx` of `full`: the
 * model's text, newline-terminated, plus the blank lines a Markdown block
 * needs on either side (a heading or paragraph written straight after the
 * previous paragraph would otherwise follow it with a single newline).
 * Never adds a blank line where there already is one, between items of
 * the same list / table / quote, next to indented lines, or inside a
 * fenced code block. An insertion at the end of a document without a
 * trailing newline starts on a new line instead of joining the last one.
 */
export function blockSpacedInsertText(full: string, idx: number, text: string): string {
  const body = text.endsWith('\n') ? text : text + '\n'
  const before = full.slice(0, idx)
  const prefix = before.length > 0 && !before.endsWith('\n') ? '\n' : ''
  if (body.trim() === '' || endsInsideCodeFence(before)) return prefix + body

  const bodyLines = body.slice(0, -1).split('\n')
  const firstInserted = bodyLines[0] ?? ''
  const lastInserted = bodyLines[bodyLines.length - 1] ?? ''
  const prevLine = before.length > 0 ? before.replace(/\n$/, '').split('\n').pop() ?? '' : null
  const nextLine = idx < full.length ? full.slice(idx).split('\n')[0] ?? '' : null

  const blankAbove = prevLine !== null && needsBlankLineBetween(prevLine, firstInserted) ? '\n' : ''
  const blankBelow = nextLine !== null && needsBlankLineBetween(lastInserted, nextLine) ? '\n' : ''
  return prefix + blankAbove + body + blankBelow
}
