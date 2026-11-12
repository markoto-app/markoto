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
