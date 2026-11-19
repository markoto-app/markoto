import { lineStartOffsets, scanBlocks } from './markdownMask'

// The section model of a Markdown document: every heading starts a section
// that runs to the next heading of the same or a higher level (its subtree)
// and owns the lines up to the next heading of any level (its own body).
// Text before the first heading is the preamble. Pure functions over a
// string; the AI reading tools (outline, read_section, search_document), the
// structural edit tools and the delegated jobs all build on it.

/** Characters per token for the estimates (German / English prose on current BPE tokenizers). */
export const CHARS_PER_TOKEN = 3.6

export interface Section {
  /** Position in document order; 0 is the preamble when the document has one. */
  index: number
  /** Heading level 1-6; 0 for the preamble. */
  level: number
  /** Heading text without the `#` marks and without a trailing attribute block; '' for the preamble. */
  title: string
  /** The explicit anchor id from an attribute block (`{#netzbetrieb}`), or null. */
  explicitId: string | null
  /** Section number ("4.2"): the heading's own numeric prefix when the document numbers its headings, else counted like a table of contents. '' for the preamble. */
  number: string
  /** Whether `number` was written in the heading (true) or counted (false). */
  numberIsLiteral: boolean
  /** The title with a literal numeric prefix removed ("Results" for "4.2 Results"). */
  bareTitle: string
  /** Ancestors and the section itself as written, joined with " > " ("3 Methods > 3.2 Sampling"). */
  headingPath: string
  /** 1-based first line (the heading line; 1 for the preamble). */
  startLine: number
  /** Number of lines the heading takes (1 for ATX, 2 for setext, 0 for the preamble). */
  headingLines: number
  /** Last line of the section's own text: the line before the next heading of any level. */
  bodyEndLine: number
  /** Last line of the subtree: the line before the next heading of the same or a higher level. */
  endLine: number
  /** Character offset of the section start. */
  startOffset: number
  /** Character offset after the subtree (after its last line's newline, or the end of the text). */
  endOffset: number
  /** Character offset after the own body. */
  bodyEndOffset: number
  /** Index of the parent section (nearest earlier heading of a lower level), or null. */
  parent: number | null
  /** Words of the subtree. */
  words: number
  /** Characters of the subtree. */
  chars: number
  /** Estimated tokens of the subtree (chars / 3.6). */
  tokens: number
  /** Short hash of the subtree text (6 hex characters); changes whenever any character of it changes. */
  rev: string
}

export interface DocumentStructure {
  text: string
  lines: string[]
  /** Character offset of each line's start. */
  lineOffsets: number[]
  /** Preamble (when there is text before the first heading) and every heading, in document order. */
  sections: Section[]
  totals: { lines: number, words: number, chars: number, tokens: number }
  /** Hash of the whole text. */
  rev: string
  /** Level jumps (a heading more than one level below its predecessor). */
  warnings: string[]
}

/** 32-bit FNV-1a of a string, as 8 hex characters. Fast, not cryptographic. */
export function shortHash(text: string): string {
  let h = 0x811C9DC5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

export function countWords(text: string): number {
  let n = 0
  let inWord = false
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    const space = c === 32 || c === 10 || c === 9 || c === 13 || c === 160
    if (!space && !inWord) n++
    inWord = !space
  }
  return n
}

export function estimateTokens(chars: number): number {
  return Math.round(chars / CHARS_PER_TOKEN)
}

const ATX_OPEN_RE = /^ {0,3}(#{1,6})(?=[ \t]|$)/
const SETEXT_RE = /^ {0,3}(?:=+|-{2,})[ \t]*$/
/** Lines that cannot be the text line of a setext heading. */
const NOT_PARAGRAPH_RE = /^(?: {4}|\t| {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)| {0,3}[>|])/
const ATTRIBUTE_CONTENT_RE = /(?:^|\s)(?:#[\w-]|\.[\w-]|[\w-]{1,99}=)/
const ATTRIBUTE_ID_RE = /(?:^|\s)#([\w-]{1,200})/

interface RawHeading { line: number, level: number, text: string, headingLines: number }

/** Whether `text` is a section number like "4", "4.2" or "4.2." (also how the model may name one). */
export function isSectionNumber(text: string): boolean {
  const parts = text.endsWith('.') ? text.slice(0, -1).split('.') : text.split('.')
  return parts.length <= 10 && parts.every(p => p.length > 0 && p.length <= 9 && /^\d+$/.test(p))
}

/** The numeric prefix of a heading title ("4.2 Results" → "4.2"), with its length, or null. */
function numberPrefix(title: string): { number: string, length: number } | null {
  const space = title.search(/[ \t]/)
  const token = space === -1 ? title : title.slice(0, space)
  if (!isSectionNumber(token)) return null
  const rest = space === -1 ? '' : title.slice(space)
  return { number: token.replace(/\.$/, ''), length: title.length - rest.trimStart().length }
}

/**
 * The title a heading rename should write: the new title, with the current
 * heading's written number kept in front ("2 Old" renamed to "New" gives
 * "2 New", "2. Old" gives "2. New") unless the new title brings its own
 * number. A model renaming "chapter 2's heading" tends to drop the number;
 * the user only loses it when they ask for that (`removeNumber`).
 */
export function titleKeepingNumber(currentTitle: string, nextTitle: string, removeNumber = false): string {
  if (removeNumber) {
    const own = numberPrefix(nextTitle)
    return own ? nextTitle.slice(own.length) : nextTitle
  }
  if (!numberPrefix(currentTitle) || numberPrefix(nextTitle)) return nextTitle
  const space = currentTitle.search(/[ \t]/)
  const token = space === -1 ? currentTitle : currentTitle.slice(0, space)
  return `${token} ${nextTitle}`
}

/** Remove an ATX closing sequence: trailing `#`s that follow a space (or are all there is). */
function stripClosingHashes(text: string): string {
  const trimmed = text.trimEnd()
  let i = trimmed.length
  while (i > 0 && trimmed[i - 1] === '#') i--
  if (i === trimmed.length) return trimmed
  if (i === 0) return ''
  return /[ \t]/.test(trimmed[i - 1] ?? '') ? trimmed.slice(0, i).trimEnd() : trimmed
}

/** Split a heading's text into title and explicit id (`Title {#id .class}`). */
export function splitHeadingText(raw: string): { title: string, explicitId: string | null } {
  const text = stripClosingHashes(raw).trim()
  if (!text.endsWith('}')) return { title: text, explicitId: null }
  const open = text.lastIndexOf('{')
  const inner = open === -1 ? '' : text.slice(open + 1, -1)
  if (open === -1 || inner.includes('}') || !ATTRIBUTE_CONTENT_RE.test(inner)) return { title: text, explicitId: null }
  return { title: text.slice(0, open).trim(), explicitId: ATTRIBUTE_ID_RE.exec(inner)?.[1] ?? null }
}

/** An ATX heading on this line, or null. */
function atxHeading(line: string, lineNo: number): RawHeading | null {
  const open = ATX_OPEN_RE.exec(line)
  const marks = open?.[1]
  if (!open || !marks) return null
  return { line: lineNo, level: marks.length, text: line.slice(open[0].length).trim(), headingLines: 1 }
}

/** A setext heading whose text is line `i` (a one-line paragraph underlined with === or ---), or null. */
function setextHeading(lines: readonly string[], blocked: ReadonlyArray<unknown>, i: number, prevHeadingEnd: number): RawHeading | null {
  const line = lines[i] ?? ''
  const next = lines[i + 1]
  if (next === undefined || blocked[i + 1] !== null || line.trim() === '') return null
  if (!SETEXT_RE.test(next) || NOT_PARAGRAPH_RE.test(line)) return null
  // A one-line paragraph: a blank line (or a heading) right above it.
  const prev = i > 0 ? lines[i - 1] ?? '' : ''
  if (prev.trim() !== '' && prevHeadingEnd !== i) return null
  return { line: i + 1, level: next.trim().startsWith('=') ? 1 : 2, text: line.trim(), headingLines: 2 }
}

function findHeadings(lines: readonly string[], blocked: ReadonlyArray<unknown>): RawHeading[] {
  const out: RawHeading[] = []
  let prevHeadingEnd = -1
  let i = 0
  while (i < lines.length) {
    const heading = blocked[i] === null ? atxHeading(lines[i] ?? '', i + 1) ?? setextHeading(lines, blocked, i, prevHeadingEnd) : null
    if (heading) {
      out.push(heading)
      prevHeadingEnd = heading.line + heading.headingLines - 1
      i += heading.headingLines
    } else {
      i += 1
    }
  }
  return out
}

/** The document numbers its headings when at least half of them carry a numeric prefix. */
function documentNumbersHeadings(titles: readonly string[]): boolean {
  const literal = titles.filter(t => numberPrefix(t) !== null).length
  return titles.length > 0 && literal * 2 >= titles.length
}

/** Line helpers over one document. */
class TextLines {
  readonly lines: string[]
  readonly offsets: number[]
  constructor(readonly text: string) {
    this.lines = text.split('\n')
    this.offsets = lineStartOffsets(this.lines)
  }

  /** Offset of the start of 1-based `line` (the end of the text past the last line). */
  startOf(line: number): number {
    return this.offsets[line - 1] ?? this.text.length
  }

  /** Offset after 1-based `line` (its newline included when there is one). */
  after(line: number): number {
    return this.offsets[line] ?? this.text.length
  }
}

function preambleSection(doc: TextLines, firstHeadingLine: number): Section | null {
  const preambleEnd = firstHeadingLine - 1
  const endOffset = doc.after(preambleEnd)
  const text = doc.text.slice(0, endOffset)
  if (preambleEnd < 1 || text.trim().length === 0) return null
  return {
    index: 0,
    level: 0,
    title: '',
    explicitId: null,
    number: '',
    numberIsLiteral: false,
    bareTitle: '',
    headingPath: '(preamble)',
    startLine: 1,
    headingLines: 0,
    bodyEndLine: preambleEnd,
    endLine: preambleEnd,
    startOffset: 0,
    endOffset,
    bodyEndOffset: endOffset,
    parent: null,
    words: countWords(text),
    chars: text.length,
    tokens: estimateTokens(text.length),
    rev: shortHash(text).slice(0, 6)
  }
}

function levelJumpWarnings(sections: readonly Section[]): string[] {
  const warnings: string[] = []
  let prevLevel = 0
  for (const s of sections) {
    if (s.level === 0) continue
    if (s.level > prevLevel + 1) {
      warnings.push(`level jump: ${prevLevel === 0 ? 'start of document' : '#'.repeat(prevLevel)} to ${'#'.repeat(s.level)} at line ${s.startLine}`)
    }
    prevLevel = s.level
  }
  return warnings
}

/** Parse the section structure of `text`. */
export function parseSections(text: string): DocumentStructure {
  const doc = new TextLines(text)
  const { lineClasses } = scanBlocks(doc.lines, doc.offsets)
  const parsed = findHeadings(doc.lines, lineClasses).map(h => ({ ...h, ...splitHeadingText(h.text) }))
  const documentNumbers = documentNumbersHeadings(parsed.map(h => h.title))

  const sections: Section[] = []
  const preamble = preambleSection(doc, parsed[0]?.line ?? doc.lines.length + 1)
  if (preamble) sections.push(preamble)

  // Ancestor stack (sections) and per-parent child counters for computed numbers.
  const stack: Section[] = []
  const childCount = new Map<number | null, number>()
  parsed.forEach((h, k) => {
    while ((stack.at(-1)?.level ?? 0) >= h.level) stack.pop()
    const parent = stack.at(-1) ?? null
    const ordinal = (childCount.get(parent?.index ?? null) ?? 0) + 1
    childCount.set(parent?.index ?? null, ordinal)
    const literal = numberPrefix(h.title)
    const useLiteral = documentNumbers && literal !== null
    const nextSameOrHigher = parsed.slice(k + 1).find(o => o.level <= h.level)
    const bodyEndLine = (parsed[k + 1]?.line ?? doc.lines.length + 1) - 1
    const endLine = (nextSameOrHigher?.line ?? doc.lines.length + 1) - 1
    const startOffset = doc.startOf(h.line)
    const endOffset = doc.after(endLine)
    const subtree = text.slice(startOffset, endOffset)
    const section: Section = {
      index: sections.length,
      level: h.level,
      title: h.title,
      explicitId: h.explicitId,
      number: useLiteral ? literal.number : parent ? `${parent.number}.${ordinal}` : String(ordinal),
      numberIsLiteral: useLiteral,
      bareTitle: literal ? h.title.slice(literal.length).trim() || h.title : h.title,
      headingPath: parent ? `${parent.headingPath} > ${h.title}` : h.title,
      startLine: h.line,
      headingLines: h.headingLines,
      bodyEndLine,
      endLine,
      startOffset,
      endOffset,
      bodyEndOffset: doc.after(bodyEndLine),
      parent: parent?.index ?? null,
      words: countWords(subtree),
      chars: subtree.length,
      tokens: estimateTokens(subtree.length),
      rev: shortHash(subtree).slice(0, 6)
    }
    sections.push(section)
    stack.push(section)
  })

  return {
    text,
    lines: doc.lines,
    lineOffsets: doc.offsets,
    sections,
    totals: { lines: doc.lines.length, words: countWords(text), chars: text.length, tokens: estimateTokens(text.length) },
    rev: shortHash(text),
    warnings: levelJumpWarnings(sections)
  }
}

let lastText: string | null = null
let lastStructure: DocumentStructure | null = null

/** `parseSections` with a one-entry memo: tools parse the same text several times per call and per turn. */
export function parseSectionsCached(text: string): DocumentStructure {
  if (text !== lastText || lastStructure === null) {
    lastStructure = parseSections(text)
    lastText = text
  }
  return lastStructure
}

/** 1-based line that holds character offset `offset`. */
export function lineAtOffset(structure: DocumentStructure, offset: number): number {
  const offs = structure.lineOffsets
  let lo = 0
  let hi = offs.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if ((offs[mid] ?? Infinity) <= offset) lo = mid
    else hi = mid - 1
  }
  return lo + 1
}

/** The section whose own body holds `line` (the preamble for lines before the first heading), or null. */
export function sectionAtLine(structure: DocumentStructure, line: number): Section | null {
  const secs = structure.sections
  let lo = 0
  let hi = secs.length - 1
  let found: Section | null = null
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const s = secs[mid]
    if (s && s.startLine <= line) {
      found = s
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return found
}

/** The section's label as the document writes it: "4.2 Results", or a counted number in front of an unnumbered title. */
export function sectionLabel(section: Section): string {
  if (section.level === 0) return '(preamble)'
  return section.numberIsLiteral ? section.title : `${section.number} ${section.title}`
}

/** Sections inside `section`'s subtree (itself excluded). */
export function descendants(structure: DocumentStructure, section: Section): Section[] {
  return structure.sections.filter(s => s.index > section.index && s.startLine <= section.endLine && s.level > section.level)
}
