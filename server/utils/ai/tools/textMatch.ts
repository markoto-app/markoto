// Finding `replace_text`'s `old_str` in the document. Models copy text with
// small drifts: curly quotes typed as straight ones (the preview renders
// smart quotes, Word pastes bring them), dashes and non-breaking spaces
// swapped, trailing spaces lost. Matching runs in tiers, each one only when
// the previous found nothing: exact, then typographic normalisation, then
// that plus trailing whitespace ignored at line ends. A match found in a
// normalised tier is mapped back to offsets in the ORIGINAL text, so the
// edit replaces the document's own characters. Every tier applies the same
// uniqueness rule: more than one match is an error, never a guess.

export type MatchTier = 'exact' | 'typographic' | 'trailing-whitespace'

export type MatchResult
  = | { kind: 'unique', start: number, end: number, tier: MatchTier }
    | { kind: 'multiple', count: number, tier: MatchTier, lines: number[] }
    | { kind: 'none' }

const SINGLE_QUOTES = '\u2018\u2019\u201A\u201B\u2032\u2039\u203A'
const DOUBLE_QUOTES = '\u201C\u201D\u201E\u201F\u2033\u00AB\u00BB'
const DASHES = '\u2010\u2011\u2012\u2013\u2014\u2015\u2212\uFE58\uFE63\uFF0D'
const SPACES = '\u00A0\u202F\u2007\u2009\u200A\u2002\u2003\u2004\u2005\u2006'
const ELLIPSIS = '\u2026'

/** The typographic replacement for one character, or the character itself. */
function normaliseChar(ch: string): string {
  if (SINGLE_QUOTES.includes(ch)) return '\''
  if (DOUBLE_QUOTES.includes(ch)) return '"'
  if (DASHES.includes(ch)) return '-'
  if (SPACES.includes(ch)) return ' '
  if (ch === ELLIPSIS) return '...'
  return ch
}

/**
 * A normalised copy of a text with, for every character of the copy, the
 * original range it came from. One original character can become several
 * (an ellipsis becomes three dots) or none (trailing whitespace).
 */
interface MappedText {
  text: string
  /** Original start offset of the character's source. */
  from: number[]
  /** Original end offset (exclusive) of the character's source. */
  to: number[]
  /** First character produced by its source (a match must not start mid-ellipsis). */
  first: boolean[]
  /** Last character produced by its source. */
  last: boolean[]
}

function isTrailingSpace(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t'
}

function mapText(src: string, trimTrailing: boolean): MappedText {
  const chars: string[] = []
  const from: number[] = []
  const to: number[] = []
  const first: boolean[] = []
  const last: boolean[] = []
  const dropTrailing = (): void => {
    while (isTrailingSpace(chars[chars.length - 1])) {
      chars.pop()
      from.pop()
      to.pop()
      first.pop()
      last.pop()
    }
  }
  for (let i = 0; i < src.length; i++) {
    const ch = src.charAt(i)
    if (trimTrailing && ch === '\n') dropTrailing()
    const out = normaliseChar(ch)
    for (let k = 0; k < out.length; k++) {
      chars.push(out.charAt(k))
      from.push(i)
      to.push(i + 1)
      first.push(k === 0)
      last.push(k === out.length - 1)
    }
  }
  if (trimTrailing) dropTrailing()
  return { text: chars.join(''), from, to, first, last }
}

function normalisedNeedle(needle: string, trimTrailing: boolean): string {
  return mapText(needle, trimTrailing).text
}

/** 1-based line number of a character offset. */
export function lineOfOffset(text: string, offset: number): number {
  let line = 1
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) line += 1
  }
  return line
}

const MAX_REPORTED_LINES = 10

/** Non-overlapping exact occurrences of `needle` in `haystack`. */
function exactMatches(haystack: string, needle: string): number[] {
  const out: number[] = []
  if (needle.length === 0) return out
  let i = 0
  while (true) {
    const pos = haystack.indexOf(needle, i)
    if (pos === -1) return out
    out.push(pos)
    i = pos + needle.length
  }
}

/** Non-overlapping matches in a mapped text, as original [start, end) ranges. */
function mappedMatches(mapped: MappedText, needle: string): Array<[number, number]> {
  const out: Array<[number, number]> = []
  if (needle.length === 0) return out
  let i = 0
  while (true) {
    const pos = mapped.text.indexOf(needle, i)
    if (pos === -1) return out
    const end = pos + needle.length - 1
    // A match that splits an expanded character (two of an ellipsis's three
    // dots) has no exact counterpart in the original.
    const start = mapped.from[pos]
    const stop = mapped.to[end]
    if (mapped.first[pos] && mapped.last[end] && start !== undefined && stop !== undefined) {
      out.push([start, stop])
      i = pos + needle.length
    } else {
      i = pos + 1
    }
  }
}

function resultOf(full: string, ranges: Array<[number, number]>, tier: MatchTier): MatchResult | null {
  const [only] = ranges
  if (!only) return null
  if (ranges.length === 1) return { kind: 'unique', start: only[0], end: only[1], tier }
  return {
    kind: 'multiple',
    count: ranges.length,
    tier,
    lines: ranges.slice(0, MAX_REPORTED_LINES).map(([s]) => lineOfOffset(full, s))
  }
}

/** Find `needle` in `full`, tier by tier (see the module comment). */
export function findEditTarget(full: string, needle: string): MatchResult {
  if (needle.length === 0) return { kind: 'none' }
  const exact = resultOf(full, exactMatches(full, needle).map(p => [p, p + needle.length]), 'exact')
  if (exact) return exact
  for (const [tier, trim] of [['typographic', false], ['trailing-whitespace', true]] as const) {
    const n = normalisedNeedle(needle, trim)
    if (n.trim().length === 0) continue
    const found = resultOf(full, mappedMatches(mapText(full, trim), n), tier)
    if (found) return found
  }
  return { kind: 'none' }
}

/** First line where `needle` occurs in `full` at any tier, or null. */
export function firstOccurrenceLine(full: string, needle: string): number | null {
  if (needle.trim().length === 0) return null
  const found = findEditTarget(full, needle)
  if (found.kind === 'unique') return lineOfOffset(full, found.start)
  if (found.kind === 'multiple') return found.lines[0] ?? null
  return null
}

// Closest lines on a miss

const MAX_CLOSEST_LINES = 12
const MAX_NEEDLE_LINES_VOTING = 60
/** Share of a needle line's words a document line must contain to vote. */
const MIN_LINE_OVERLAP = 0.6
const CLOSEST_LINE_MAX_CHARS = 600

function wordsOf(line: string): Set<string> {
  return new Set(mapText(line, false).text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
}

function overlap(needleWords: Set<string>, lineWords: Set<string>): number {
  if (needleWords.size === 0) return 0
  let shared = 0
  for (const w of needleWords) if (lineWords.has(w)) shared += 1
  return shared / needleWords.size
}

/**
 * The 1-based [from, to] lines of the document that look most like
 * `needle`: every needle line votes for the document lines that contain
 * most of its words, at the offset that line has inside the needle, and
 * the start line with the most votes wins. Null when nothing is similar.
 */
export function closestLineRange(full: string, needle: string): { from: number, to: number } | null {
  const docLines = full.split('\n')
  const needleLines = needle.split('\n').slice(0, MAX_NEEDLE_LINES_VOTING)
  const docWords: Array<Set<string> | undefined> = []
  const votes = new Map<number, number>()
  needleLines.forEach((nLine, k) => {
    const nWords = wordsOf(nLine)
    if (nWords.size === 0) return
    // Short lines ("## Ziel") match everywhere; they count for less.
    const weight = Math.min(1, nWords.size / 4)
    for (let j = 0; j < docLines.length; j++) {
      const words = docWords[j] ?? (docWords[j] = wordsOf(docLines[j] ?? ''))
      const score = overlap(nWords, words)
      if (score < MIN_LINE_OVERLAP) continue
      const start = j - k
      votes.set(start, (votes.get(start) ?? 0) + score * weight)
    }
  })
  let best: number | null = null
  let bestVotes = 0
  for (const [start, v] of votes) {
    if (v > bestVotes || (v === bestVotes && best !== null && start < best)) {
      best = start
      bestVotes = v
    }
  }
  if (best === null) return null
  const from = Math.max(1, best + 1)
  const to = Math.min(docLines.length, from + Math.max(1, needleLines.length) - 1, from + MAX_CLOSEST_LINES - 1)
  return { from, to }
}

/** The lines `closestLineRange` picked, numbered like view_document; long lines are cut. */
export function formatClosestLines(full: string, range: { from: number, to: number }): string {
  const lines = full.split('\n').slice(range.from - 1, range.to)
  return lines.map((line, i) => {
    const shown = line.length > CLOSEST_LINE_MAX_CHARS ? `${line.slice(0, CLOSEST_LINE_MAX_CHARS)} [line continues]` : line
    return `${range.from + i}: ${shown}`
  }).join('\n')
}
