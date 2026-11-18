import type { MaskClass, MaskRange } from './markdownMask'
import { parseSections, type DocumentStructure } from './parse'
import { searchLines, type SearchMatch, type SearchQuery } from './search'
import { applyTextEdits } from './anchorLinks'

// The plan of a replace_all call: every match of the query (search.ts rules:
// excluded Markdown classes are skipped and counted), the text each one
// becomes (capture groups expanded, case adjusted, or the whole word from a
// `forms` list), the word forms the matches sit in (so a stem replacement in
// German compounds can be checked), and which headings would change level.
// Pure; the tool layer previews the plan or applies it in one Y.js
// transaction.

export type ReplaceCase = 'preserve' | 'as_given'

/** A whole word and what it becomes (`forms` mode). */
export interface WordForm {
  word: string
  replacement: string
}

export interface ReplaceAllQuery extends SearchQuery {
  replacement: string
  case?: ReplaceCase
  /**
   * Replace whole words instead of the match: each match's surrounding word
   * is looked up here (any case) and replaced by its entry; words that
   * contain the query but are not listed stay unchanged.
   */
  forms?: readonly WordForm[]
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

export interface ReplaceAllPlan {
  /** Every match, including those whose text would not change. */
  matches: PlannedMatch[]
  skipped: Partial<Record<MaskClass, number>>
  truncated: boolean
  /** `forms` mode: matched words that are not in the list (left unchanged), with counts. */
  unlisted: Array<{ word: string, count: number }>
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

const WORD_CHAR_RE = /[\p{L}\p{N}_]/u

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && ch !== '' && WORD_CHAR_RE.test(ch)
}

/** The whole word around [start, end) in `text` (letters, digits, underscore). */
export function wordAround(text: string, start: number, end: number): { start: number, end: number, word: string } {
  let s = start
  let e = end
  while (s > 0 && isWordChar(text[s - 1])) s--
  while (e < text.length && isWordChar(text[e])) e++
  return { start: s, end: e, word: text.slice(s, e) }
}

/** `forms` mode: one planned match per listed word (several query hits in one word count once). */
function planForms(text: string, matches: readonly SearchMatch[], forms: readonly WordForm[]): { matches: PlannedMatch[], unlisted: ReplaceAllPlan['unlisted'] } {
  const byWord = new Map(forms.map(f => [f.word.toLowerCase(), f]))
  const out: PlannedMatch[] = []
  const unlisted = new Map<string, number>()
  let lastEnd = -1
  for (const m of matches) {
    const w = wordAround(text, m.start, m.end)
    if (w.start < lastEnd) continue
    lastEnd = w.end
    const form = byWord.get(w.word.toLowerCase())
    if (!form) {
      unlisted.set(w.word, (unlisted.get(w.word) ?? 0) + 1)
      continue
    }
    out.push({ k: out.length + 1, start: w.start, end: w.end, line: m.line, before: w.word, after: preserveCase(w.word, form.replacement, form.word) })
  }
  return { matches: out, unlisted: [...unlisted].map(([word, count]) => ({ word, count })).sort((a, b) => b.count - a.count) }
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
  if (q.forms && q.forms.length > 0) {
    const f = planForms(structure.text, run.outcome.matches, q.forms)
    return { ok: true, plan: { matches: f.matches, skipped: run.outcome.skipped, truncated: run.outcome.truncated, unlisted: f.unlisted } }
  }
  const matches = run.outcome.matches.map((m, i): PlannedMatch => ({
    k: i + 1,
    start: m.start,
    end: m.end,
    line: m.line,
    before: m.text,
    after: replacementFor(q, m)
  }))
  return { ok: true, plan: { matches, skipped: run.outcome.skipped, truncated: run.outcome.truncated, unlisted: [] } }
}

/** The text after the given replacements. */
export function textAfterChanges(text: string, changes: readonly PlannedMatch[]): string {
  return applyTextEdits(text, changes.map(m => ({ start: m.start, end: m.end, text: m.after })))
}

export interface WordFormCount {
  /** The whole word as it stands. */
  word: string
  /** The word after the replacement. */
  after: string
  count: number
  /** The match sits inside a longer word (a compound), with letters after it. */
  compound: boolean
}

/** The distinct whole words the changes touch, with what each becomes, most frequent first. */
export function wordForms(text: string, changes: readonly PlannedMatch[]): WordFormCount[] {
  const forms = new Map<string, WordFormCount>()
  for (const m of changes) {
    const w = wordAround(text, m.start, m.end)
    const after = text.slice(w.start, m.start) + m.after + text.slice(m.end, w.end)
    const key = `${w.word}\u0000${after}`
    const cur = forms.get(key)
    if (cur) cur.count++
    else forms.set(key, { word: w.word, after, count: 1, compound: w.end > m.end && /^\p{Ll}/u.test(text.slice(m.end, w.end)) })
  }
  return [...forms.values()].sort((a, b) => b.count - a.count || a.word.localeCompare(b.word))
}

/**
 * German nouns with these endings take a linking "s" when they start a
 * compound (Bereitschaft + Dienst = Bereitschaftsdienst, Sicherheitskonzept,
 * Wartungsfenster). A stem replacement that ends in one of them and lands in
 * front of more letters almost always needs it.
 */
const LINKING_S_ENDINGS = ['schaft', 'heit', 'keit', 'ung', 'tät', 'ion', 'ling', 'tum', 'sicht']

/** Compound word forms where the replacement probably lacks a linking "s" (German). */
export function missingLinkingS(text: string, changes: readonly PlannedMatch[]): WordFormCount[] {
  const suspicious = changes.filter((m) => {
    const after = m.after.toLowerCase()
    if (!LINKING_S_ENDINGS.some(e => after.endsWith(e))) return false
    const w = wordAround(text, m.start, m.end)
    const tail = text.slice(m.end, w.end)
    // A compound continues with a lowercase noun part; "s", "en" and similar
    // endings are inflection, and an existing linking "s" is fine.
    return tail.length >= 3 && /^\p{Ll}/u.test(tail) && !tail.startsWith('s')
  })
  return wordForms(text, suspicious)
}

export interface LevelChange {
  line: number
  heading: string
  from: number
  to: number
}

/**
 * Headings whose level the change from `structure` to `afterText` alters
 * (paired in document order), and whether headings appear or disappear.
 */
export function headingLevelChanges(structure: DocumentStructure, afterText: string): { changed: LevelChange[], added: number, removed: number } {
  const before = structure.sections.filter(s => s.level > 0)
  const after = parseSections(afterText).sections.filter(s => s.level > 0)
  if (before.length !== after.length) {
    return { changed: [], added: Math.max(0, after.length - before.length), removed: Math.max(0, before.length - after.length) }
  }
  const changed: LevelChange[] = []
  before.forEach((s, i) => {
    const a = after[i]
    if (a && a.level !== s.level) changed.push({ line: s.startLine, heading: s.title, from: s.level, to: a.level })
  })
  return { changed, added: 0, removed: 0 }
}
