import { structuredPatch } from 'diff'

// Compute a unified line-level diff between two text snapshots and
// return it as a list of hunks suitable for the activity-log drawer
// renderer. We use the `diff` library's structuredPatch (which is
// what powers GitHub's PR review UI under the hood) because it
// produces clean hunk boundaries with N-line context windows — no
// hand-rolled diff merging needed.
//
// Two safety caps applied here:
//   - Per-line truncation at MAX_LINE_CHARS so a single 50KB line
//     can't blow the response payload.
//   - Total hunk count capped at MAX_HUNKS so a massive rewrite
//     doesn't return a megabyte of JSON. The endpoint exposes a
//     `truncated` flag the UI uses to render a "diff truncated"
//     banner.

export type DiffHunk = {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: Array<{ kind: 'context' | 'add' | 'remove', text: string }>
}

export interface DiffResult {
  hunks: DiffHunk[]
  /** True if the response was capped (rendering should warn the user). */
  truncated: boolean
  /** The total number of hunks before capping (for rendering a "showing X of Y" hint). */
  totalHunks: number
}

const MAX_HUNKS = 200
const MAX_LINE_CHARS = 2000
const CONTEXT_LINES = 3

/**
 * Build a structured unified diff. Returns hunks in the order they
 * appear in the source text — render them top-to-bottom for a
 * GitHub-PR-style read.
 *
 * Empty inputs are handled: two empty strings → empty hunks; one
 * empty string + content → a single hunk with all lines as adds (or
 * removes). The library handles these cases natively.
 */
export function computeTextDiff(beforeText: string, afterText: string): DiffResult {
  // Filenames / headers are required by the API but never rendered.
  const patch = structuredPatch('before', 'after', beforeText, afterText, '', '', { context: CONTEXT_LINES })

  function lineKindFromPrefix(prefix: string | undefined): DiffHunk['lines'][number]['kind'] {
    if (prefix === '+') return 'add'
    if (prefix === '-') return 'remove'
    return 'context'
  }

  const totalHunks = patch.hunks.length
  const truncated = totalHunks > MAX_HUNKS
  const hunksToTake = patch.hunks.slice(0, MAX_HUNKS)

  const hunks: DiffHunk[] = hunksToTake.map(h => ({
    oldStart: h.oldStart,
    oldLines: h.oldLines,
    newStart: h.newStart,
    newLines: h.newLines,
    lines: h.lines
      // Drop the `\ No newline at end of file` marker line; noise in the drawer.
      .filter(rawLine => !rawLine.startsWith('\\'))
      .map((rawLine) => {
        // Lines carry a `+`, `-` or space prefix.
        const prefix = rawLine[0]
        const text = rawLine.slice(1)
        const truncatedText = text.length > MAX_LINE_CHARS
          ? `${text.slice(0, MAX_LINE_CHARS - 1)}…`
          : text
        const kind = lineKindFromPrefix(prefix)
        return { kind, text: truncatedText }
      })
  }))

  return { hunks, truncated, totalHunks }
}
