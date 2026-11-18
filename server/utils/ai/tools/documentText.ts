import { parseSectionsCached } from './sections/parse'

// Line-numbered views of the document text, shared by the read/edit tools
// and the comment tools (line ranges → character offsets).

function withLineNumbers(text: string, startLine: number = 1): string {
  const lines = text.split('\n')
  return lines.map((line, i) => `${startLine + i}: ${line}`).join('\n')
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
    return `Lines ${firstLine}-${lastLine} now hold the new text (${lastLine - firstLine + 1} lines; read them with view_document and view_range [${firstLine}, ${lastLine}] if needed).`
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

/**
 * The note an edit result carries when the lines below the edit moved:
 * line numbers from an earlier view_document are wrong past `afterLine`
 * (numbered as before the edit). Null when nothing shifted.
 */
export function lineShiftNote(afterLine: number, shift: number): string | null {
  if (shift === 0) return null
  const signed = shift > 0 ? `+${shift}` : `${shift}`
  return `Line numbers after line ${afterLine} shifted by ${signed}; earlier views are out of date below that line.`
}

/** Number of line breaks in a string. */
export function newlineCount(text: string): number {
  let n = 0
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n += 1
  return n
}

// Outline and bounded views

export interface OutlineEntry {
  /** 1-based line of the heading. */
  line: number
  /** Last line of the section: the line before the next heading of the same or a higher level. */
  endLine: number
  level: number
  /** The heading line as written (with its `#` marks). */
  heading: string
}

/**
 * The document's headings with the line range each section spans
 * (subsections included), from the section parser (`sections/parse.ts`):
 * lines inside fenced code, math blocks and HTML comments are skipped, so a
 * `# comment` in a shell snippet is not a heading.
 */
export function documentOutline(text: string): OutlineEntry[] {
  const { sections, lines } = parseSectionsCached(text)
  return sections
    .filter(s => s.level > 0)
    .map(s => ({ line: s.startLine, endLine: s.endLine, level: s.level, heading: (lines[s.startLine - 1] ?? '').trim() }))
}

/**
 * The outline as text, one heading per line ("[12-40] ## 1.2 Title"),
 * limited to the deepest heading level that fits in `maxChars`. Says how
 * many deeper headings were left out.
 */
export function formatOutline(entries: readonly OutlineEntry[], maxChars: number): string {
  const row = (e: OutlineEntry): string => `[${e.line}-${e.endLine}] ${e.heading}`
  for (let depth = 6; depth >= 1; depth--) {
    const shown = entries.filter(e => e.level <= depth)
    const text = shown.map(row).join('\n')
    if (text.length <= maxChars || depth === 1) {
      const omitted = entries.length - shown.length
      const capped = text.length > maxChars ? `${text.slice(0, text.lastIndexOf('\n', maxChars))}\n[outline cut]` : text
      return omitted > 0 ? `${capped}\n(${omitted} deeper headings not listed; reading a section shows them.)` : capped
    }
  }
  return ''
}

/**
 * Lines `startLine`..`endLine` (1-based, inclusive) of `lines`, numbered
 * like view_document, cut at a whole line so the result stays within
 * `maxChars`. A single line longer than the budget is cut mid-line.
 * `lastLine` is the last line shown in full (or partly, when cut mid-line).
 */
export function numberedLines(lines: readonly string[], startLine: number, endLine: number, maxChars: number): { text: string, lastLine: number, cut: boolean } {
  const out: string[] = []
  let size = 0
  for (let n = startLine; n <= endLine && n <= lines.length; n++) {
    const row = `${n}: ${lines[n - 1]}`
    const added = row.length + (out.length > 0 ? 1 : 0)
    if (size + added > maxChars) {
      if (out.length === 0) return { text: `${row.slice(0, maxChars)} [line cut]`, lastLine: n, cut: true }
      return { text: out.join('\n'), lastLine: n - 1, cut: true }
    }
    out.push(row)
    size += added
  }
  return { text: out.join('\n'), lastLine: Math.min(endLine, lines.length), cut: false }
}

/** Part of a view's budget the outline may take before deeper heading levels are dropped. */
const OUTLINE_CHAR_BUDGET = 8_000

/** About how many lines of this document fit in one view of `budget` characters. */
function linesPerCall(lines: readonly string[], budget: number): number {
  const avg = lines.reduce((n, l) => n + l.length + 7, 0) / Math.max(1, lines.length)
  return Math.max(1, Math.floor(budget / avg))
}

/**
 * A line-numbered view of `fullText` that stays within `budget`
 * characters. `readCall` names the call that reads more ("view_document",
 * or `view_other_document (doc_id "x")`), for the continuation hints;
 * `longDocumentHint` is added to the advice for a document too long to show.
 *
 * - No range, document fits: the whole text.
 * - No range, too long: the heading outline (with each section's line
 *   range) plus the first lines, and how to read the rest.
 * - A range that does not fit: as many whole lines as fit, then the
 *   view_range that continues it.
 */
export function boundedDocumentView(fullText: string, range: readonly [number, number] | undefined, budget: number, readCall: string, longDocumentHint: string = ''): string {
  const lines = fullText.split('\n')
  if (!range) {
    const whole = numberedLines(lines, 1, lines.length, budget)
    if (!whole.cut) return whole.text
    const outline = formatOutline(documentOutline(fullText), Math.min(OUTLINE_CHAR_BUDGET, Math.floor(budget / 2)))
    const intro = `The document has ${lines.length} lines (${fullText.length} characters), too long for one result. Outline (each heading with the line range of its section, subsections included):\n${outline || '(no headings)'}`
    const head = numberedLines(lines, 1, lines.length, Math.max(1_000, budget - intro.length - 300))
    return `${intro}\n\nRead any part with ${readCall} and view_range [start, end]; about ${linesPerCall(lines, budget)} lines fit in one call.${longDocumentHint ? ` ${longDocumentHint}` : ''} Lines 1-${head.lastLine} follow:\n\n${head.text}`
  }

  const [start, end] = range
  if (start > lines.length) {
    return `The document has only ${lines.length} lines; view_range [${start}, ${end}] starts after the last line.`
  }
  const last = end === -1 ? lines.length : Math.min(end, lines.length)
  const view = numberedLines(lines, start, last, budget)
  if (!view.cut) return view.text
  const next = view.lastLine + 1
  const hint = next <= last
    ? `Shown: lines ${start}-${view.lastLine} of the requested ${start}-${last} (result size limit). Continue with ${readCall} and view_range [${next}, ${Math.min(last, view.lastLine + linesPerCall(lines, budget))}].`
    : `Line ${view.lastLine} is longer than one result allows and was cut.`
  return `${view.text}\n\n[${hint}]`
}
