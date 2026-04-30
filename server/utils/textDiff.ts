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
  // structuredPatch wants filenames + headers it baked in at the top
  // of the format. We supply placeholders since we don't render them.
  const patch = structuredPatch('before', 'after', beforeText, afterText, '', '', { context: CONTEXT_LINES })

  const totalHunks = patch.hunks.length
  const truncated = totalHunks > MAX_HUNKS
  const hunksToTake = patch.hunks.slice(0, MAX_HUNKS)

  const hunks: DiffHunk[] = hunksToTake.map(h => ({
    oldStart: h.oldStart,
    oldLines: h.oldLines,
    newStart: h.newStart,
    newLines: h.newLines,
    lines: h.lines
      // The library emits a `\ No newline at end of file` marker line
      // as metadata about the previous line — useful in patch files
      // but pure noise in our drawer (the user doesn't care about
      // trailing-newline pedantry). Filter it out.
      .filter(rawLine => rawLine[0] !== '\\')
      .map((rawLine) => {
        // The library prefixes each line with one of `+ - ` (space
        // for context). We split off the prefix and map to our own
        // kind union.
        const prefix = rawLine[0]
        const text = rawLine.slice(1)
        const truncatedText = text.length > MAX_LINE_CHARS
          ? `${text.slice(0, MAX_LINE_CHARS - 1)}…`
          : text
        const kind: DiffHunk['lines'][number]['kind']
          = prefix === '+'
            ? 'add'
            : prefix === '-'
              ? 'remove'
              : 'context'
        return { kind, text: truncatedText }
      })
  }))

  return { hunks, truncated, totalHunks }
}
