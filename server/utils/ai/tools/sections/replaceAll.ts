import type { MaskClass, MaskRange } from './markdownMask'
import { sectionAtLine, type DocumentStructure, type Section } from './parse'
import { searchLines, type SearchMatch, type SearchQuery } from './search'
import { currentHeadingAnchors, explicitIdInsertion, isAtxHeading } from './headingAnchors'

// The plan of a replace_all call: every match of the query (search.ts rules:
// excluded Markdown classes are skipped and counted), the text each one
// becomes (capture groups expanded, case adjusted), and the old anchor ids
// to pin on headings whose text the replacement changes. Pure; the tool
// layer previews the plan or applies it in one Y.js transaction.

export type ReplaceCase = 'preserve' | 'as_given'

export interface ReplaceAllQuery extends SearchQuery {
  replacement: string
  case?: ReplaceCase
}

export interface PlannedMatch {
  /** 1-based number in document order (the `k` of the match id `m<k>@<rev>`). */
  k: number
  start: number
  end: number
  line: number
  before: string
  after: string
}

/** An explicit id written into a heading line so its old anchor survives the rename. */
export interface HeadingPin {
  /** Offset where `text` is inserted. */
  offset: number
  text: string
  line: number
  id: string
  /** Index of the heading's section. */
  section: number
}

export interface ReplaceAllPlan {
  /** Every match, including those whose text would not change. */
  matches: PlannedMatch[]
  skipped: Partial<Record<MaskClass, number>>
  truncated: boolean
}

/** Expand `$1`..`$99`, `$&` and `$$` in a regex replacement. */
function expandReplacement(template: string, matched: string, groups: readonly string[]): string {
  return template.replace(/\$(\$|&|\d{1,2})/g, (whole, ref: string) => {
    if (ref === '$') return '$'
    if (ref === '&') return matched
    const n = Number(ref)
    if (n >= 1 && n <= groups.length) return groups[n - 1] ?? ''
    // `$12` with only one group: `$1` followed by "2", as String#replace does.
    if (ref.length === 2) {
      const one = Number(ref[0])
      if (one >= 1 && one <= groups.length) return `${groups[one - 1] ?? ''}${ref[1]}`
    }
    return whole
  })
}

const LETTER_RE = /\p{L}/u

function casePattern(text: string): 'upper' | 'lower' | 'capitalized' | 'mixed' {
  if (!LETTER_RE.test(text)) return 'mixed'
  const upper = text.toUpperCase()
  const lower = text.toLowerCase()
  if (text === lower) return 'lower'
  const letters = [...text].filter(c => LETTER_RE.test(c))
  if (text === upper) return letters.length > 1 ? 'upper' : 'capitalized'
  const [first, ...rest] = letters
  if (first && first === first.toUpperCase() && rest.join('') === rest.join('').toLowerCase()) return 'capitalized'
  return 'mixed'
}

function capitalizeFirstLetter(text: string): string {
  const i = text.search(LETTER_RE)
  if (i === -1) return text
  const ch = String.fromCodePoint(text.codePointAt(i) ?? 0)
  return text.slice(0, i) + ch.toUpperCase() + text.slice(i + ch.length)
}

/**
 * Carry the case of the matched text over to the replacement:
 * MYPRODUCT → MYSUPERCOOLPRODUCT, myproduct → mysupercoolproduct,
 * Kunde (query "kunde", replacement "klient") → Klient. A match written
 * exactly like the query, or in mixed case (MyProduct), gets the
 * replacement as given.
 */
function preserveCase(matched: string, replacement: string, query: string | null): string {
  if (query !== null && matched === query) return replacement
  switch (casePattern(matched)) {
    case 'upper':
      return replacement.toUpperCase()
    case 'lower':
      return replacement.toLowerCase()
    case 'capitalized':
      return capitalizeFirstLetter(replacement)
    case 'mixed':
      return replacement
  }
}

function replacementFor(q: ReplaceAllQuery, m: SearchMatch): string {
  const raw = q.regex ? expandReplacement(q.replacement, m.text, m.groups) : q.replacement
  // With caseSensitive the model chose the exact case it wants.
  if ((q.case ?? 'preserve') === 'as_given' || q.caseSensitive) return raw
  return preserveCase(m.text, raw, q.regex ? null : q.query)
}

/** Plan every replacement of `q` in lines [startLine, endLine] (the whole document by default). */
export function planReplaceAll(
  structure: DocumentStructure,
  masks: readonly MaskRange[],
  q: ReplaceAllQuery,
  range: { startLine?: number, endLine?: number } = {}
): { ok: true, plan: ReplaceAllPlan } | { ok: false, error: string } {
  const run = searchLines(structure, masks, q, range)
  if (!run.ok) return run
  const matches = run.outcome.matches.map((m, i): PlannedMatch => ({
    k: i + 1,
    start: m.start,
    end: m.end,
    line: m.line,
    before: m.text,
    after: replacementFor(q, m)
  }))
  return { ok: true, plan: { matches, skipped: run.outcome.skipped, truncated: run.outcome.truncated } }
}

/** The heading whose text line holds `line`, or null (body lines, setext underlines). */
function headingOnLine(structure: DocumentStructure, line: number): Section | null {
  const s = sectionAtLine(structure, line)
  return s && s.level > 0 && s.startLine === line ? s : null
}

/**
 * Explicit ids for headings whose text the given replacements change and
 * that have none yet: their current anchor (`currentHeadingAnchors`), so
 * links to the old heading keep working.
 */
export function headingPinsFor(structure: DocumentStructure, changes: readonly PlannedMatch[]): HeadingPin[] {
  const touched = new Map<number, Section>()
  for (const m of changes) {
    if (m.before === m.after) continue
    const h = headingOnLine(structure, m.line)
    if (h && h.explicitId === null) touched.set(h.index, h)
  }
  if (touched.size === 0) return []
  const anchors = currentHeadingAnchors(structure)
  const pins: HeadingPin[] = []
  for (const h of touched.values()) {
    const id = anchors.get(h.index)
    const line = structure.lines[h.startLine - 1] ?? ''
    const at = id ? explicitIdInsertion(line, isAtxHeading(h), id) : null
    if (!id || !at) continue
    pins.push({ offset: (structure.lineOffsets[h.startLine - 1] ?? 0) + at.column, text: at.text, line: h.startLine, id, section: h.index })
  }
  return pins
}
