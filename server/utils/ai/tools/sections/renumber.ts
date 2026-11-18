import { isSectionNumber, type DocumentStructure, type Section } from './parse'

// Renumber a document's numbered headings in document order ("1", "1.1",
// "1.1.1" ...), for instance after sections were swapped or moved. Only the
// number in front of each heading changes: the `#` marks, the level, the
// title, an `{#id}` block and an ATX closing sequence stay exactly as they
// are. Pure; the tool layer applies the plan in one Y.js transaction.
//
// The depth of a number follows the heading level: the highest level that
// carries a number (usually H1 chapters, or H2 when the H1 is the title) is
// depth 1. A heading without a number is left alone and does not count. A
// heading whose number has a different depth than its level (an "## 3"
// among "## 3.1" headings) is left alone and reported, so an unusual scheme
// is never "corrected" into something the author did not write.

export interface RenumberChange {
  /** Section index of the heading. */
  section: number
  line: number
  level: number
  /** Offsets of the number token in the text (a trailing "." is not part of it). */
  start: number
  end: number
  from: string
  to: string
  /** The heading text after the number, for the result listing. */
  rest: string
}

export interface RenumberPlan {
  changes: RenumberChange[]
  /** Numbered headings seen (changed or not). */
  numbered: number
  /** Headings left alone because their number's depth does not match their level. */
  mismatched: Array<{ line: number, heading: string }>
  baseLevel: number
}

/** `4.2` / `4.2.` at the start of the heading text: the number without the trailing dot, or null. */
function numberToken(content: string): string | null {
  const space = content.search(/[ \t]/)
  const token = space === -1 ? content : content.slice(0, space)
  if (!isSectionNumber(token)) return null
  return token.endsWith('.') ? token.slice(0, -1) : token
}

/** Where the heading text starts on its (first) line: after the `#` marks for ATX, after the indent for setext. */
function contentStart(line: string, atx: boolean): number {
  const m = atx ? /^ {0,3}#{1,6}[ \t]*/.exec(line) : /^[ \t]*/.exec(line)
  return m ? m[0].length : 0
}

interface NumberedHeading {
  section: Section
  start: number
  token: string
  parts: number[]
}

function numberedHeading(structure: DocumentStructure, s: Section): NumberedHeading | null {
  if (s.level === 0) return null
  const line = structure.lines[s.startLine - 1] ?? ''
  const col = contentStart(line, s.headingLines === 1)
  const token = numberToken(line.slice(col))
  if (!token) return null
  return { section: s, start: (structure.lineOffsets[s.startLine - 1] ?? 0) + col, token, parts: token.split('.').map(Number) }
}

/** The plan to renumber every numbered heading of `structure`, or an error when it has none. */
export function planRenumber(structure: DocumentStructure): { ok: true, plan: RenumberPlan } | { ok: false, error: string } {
  const numbered = structure.sections.map(s => numberedHeading(structure, s)).filter((h): h is NumberedHeading => h !== null)
  if (numbered.length === 0) return { ok: false, error: 'Error: no heading starts with a number ("3", "3.2"); there is nothing to renumber. To add numbers, use set_heading per heading.' }
  const baseLevel = Math.min(...numbered.map(h => h.section.level))
  // Counting starts at the lowest top-level number the document uses (1, or
  // 0 for a "0 Einleitung"), not at the first heading's: after swapping
  // chapters 1 and 2 the first heading reads "2".
  const start = Math.min(...numbered.filter(h => h.section.level === baseLevel).map(h => h.parts[0] ?? 1))
  const counters: number[] = [start - 1]
  const changes: RenumberChange[] = []
  const mismatched: RenumberPlan['mismatched'] = []

  for (const h of numbered) {
    const depth = h.section.level - baseLevel
    if (h.parts.length !== depth + 1) {
      mismatched.push({ line: h.section.startLine, heading: h.section.title })
      continue
    }
    counters.length = depth + 1
    for (let d = 0; d < depth; d++) counters[d] ??= 1
    counters[depth] = (counters[depth] ?? 0) + 1
    const to = counters.join('.')
    if (to === h.token) continue
    const line = structure.lines[h.section.startLine - 1] ?? ''
    const rest = line.slice(h.start - (structure.lineOffsets[h.section.startLine - 1] ?? 0) + h.token.length).replace(/^\.?[ \t]*/, '')
    changes.push({ section: h.section.index, line: h.section.startLine, level: h.section.level, start: h.start, end: h.start + h.token.length, from: h.token, to, rest })
  }
  return { ok: true, plan: { changes, numbered: numbered.length, mismatched, baseLevel } }
}
