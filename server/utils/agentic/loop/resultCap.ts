import { TOOL_RESULT_CHAR_CAP } from '../limits'

// The loop's last bound on a tool result (`TOOL_RESULT_CHAR_CAP`). The
// reading tools keep below it themselves; this catches the rest (a huge
// comment, a long page summary, a knowledge file) and tells the model how
// to get what was cut instead of silently dropping it.

/** Room kept for the trailer, so a cut result stays within the cap. */
const TRAILER_RESERVE = 400

const LINE_NO_RE = /^(\d+): /

/** The first and last `N:` line numbers of a line-numbered result: where it ends and how many lines it held. */
function lastNumberedLine(text: string): { line: number, count: number } | null {
  const numbers = text.split('\n').flatMap((row) => {
    const n = LINE_NO_RE.exec(row)?.[1]
    return n ? [Number(n)] : []
  })
  const first = numbers[0]
  const last = numbers[numbers.length - 1]
  if (first === undefined || last === undefined) return null
  return { line: last, count: Math.max(1, last - first + 1) }
}

function docIdArg(args: unknown): string | null {
  if (typeof args !== 'object' || args === null) return null
  const id = (args as Record<string, unknown>).doc_id
  return typeof id === 'string' ? id : null
}

/** How to read what was cut, per tool. */
function continuationHint(name: string, args: unknown, kept: string): string {
  const numbered = lastNumberedLine(kept)
  if (name === 'view_document' && numbered) {
    return `Continue with view_document and view_range [${numbered.line + 1}, ${numbered.line + numbered.count}].`
  }
  if (name === 'view_other_document' && numbered) {
    const id = docIdArg(args)
    return `Continue with view_other_document${id ? ` (doc_id "${id}")` : ''} and view_range [${numbered.line + 1}, ${numbered.line + numbered.count}].`
  }
  if (name === 'get_knowledge_file') return 'Use search_knowledge with a targeted query for the part you need.'
  if (name === 'read_comments') return 'Comments further down were not shown; work with the threads above or ask the user which thread they mean.'
  return 'Ask for less at once (a narrower range or a more specific query) to see the rest.'
}

/**
 * `output` cut to `cap` characters at a line break, with a trailer naming
 * how much was cut and how to read the rest. Unchanged when it fits.
 */
export function capToolOutput(name: string, args: unknown, output: string, cap: number = TOOL_RESULT_CHAR_CAP): string {
  if (output.length <= cap) return output
  const limit = cap - TRAILER_RESERVE
  const lineBreak = output.lastIndexOf('\n', limit)
  const kept = lineBreak > limit / 2 ? output.slice(0, lineBreak) : output.slice(0, limit)
  return `${kept}\n\n[Result cut at ${kept.length} of ${output.length} characters (tool result size limit). ${continuationHint(name, args, kept)}]`
}
