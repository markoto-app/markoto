import { CHARS_PER_TOKEN, estimateTokens, parseSections, sectionAtLine, lineAtOffset, shortHash, type DocumentStructure, type Section } from '../tools/sections/parse'
import { scanBlocks, type LineClass } from '../tools/sections/markdownMask'

// The unit splitter of a delegated job: which parts of the document one
// worker call transforms. Pure (explicit imports only, no Nitro), so an
// external eval harness can import it.
//
// A unit is a contiguous character range on line boundaries. The default
// ("auto") takes the deepest heading level whose sections fit the token
// window, merges small adjacent siblings up to the minimum, and splits an
// oversize run without headings at blank lines that are not inside a
// fence, a table or a list. `granularity` overrides; summaries use whole
// chapters, scans large chunks, `onlyMatching` paragraph units around the
// matches. Rewriting modes then pack adjacent units up to
// `UNIT_TARGET_TOKENS`.

export type JobMode = 'rewrite' | 'translate' | 'terminology' | 'summarise' | 'comment' | 'scan'

export type JobGranularity = 'auto' | 'chapter' | 'section' | 'paragraph'

/** What a job transforms: the whole document, listed sections (with their subtrees) or one section's subtree. Section indexes into `parseSections(text).sections`. */
export type JobTargets = 'all' | { sections: number[] } | { under: number }

const UNIT_MIN_TOKENS = 400
export const UNIT_MAX_TOKENS = 2500
/**
 * What adjacent units are packed up to for the rewriting modes
 * (rewrite, translate, terminology): fewer, fuller calls keep a whole
 * document under the per-job unit cap (200 on the hosted free tier) and
 * give the worker more context. Never above `UNIT_MAX_TOKENS`.
 */
const UNIT_TARGET_TOKENS = 2200
const PACKED_MODES: ReadonlySet<JobMode> = new Set(['rewrite', 'translate', 'terminology'])
/** Largest unit of a summary (one chapter). */
export const SUMMARY_UNIT_MAX_TOKENS = 20_000
/** Largest chapter unit of the other modes when `granularity: 'chapter'` is asked for. */
const CHAPTER_UNIT_MAX_TOKENS = 8000
/** Scan chunks: few, large calls. */
const SCAN_UNIT_MAX_TOKENS = 15_000
const SCAN_UNIT_MIN_TOKENS = 4000

export interface JobUnit {
  /** 0-based position in the job, in document order. */
  ordinal: number
  /** Heading path of the section the unit starts in ("3 Methods > 3.2 Sampling"; "(preamble)"). */
  headingPath: string
  /** Character offsets in the text the units were built from. */
  start: number
  end: number
  text: string
  tokens: number
  /** Hash of `text` (8 hex characters, `shortHash`). */
  rev: string
}

export interface SplitOptions {
  mode: JobMode
  granularity?: JobGranularity
  /** Only paragraphs containing a match become units (terminology). */
  onlyMatching?: RegExp | null
  minTokens?: number
  maxTokens?: number
}

interface Span {
  start: number
  end: number
  /** Merge group: only spans of one group merge (children of one section). */
  group: number
}

/** Line facts of one document the splitter needs. */
class DocLines {
  readonly lineClasses: LineClass[]
  constructor(readonly s: DocumentStructure) {
    this.lineClasses = scanBlocks(s.lines, s.lineOffsets).lineClasses
  }

  /** 0-based line index holding `offset`. */
  lineOf(offset: number): number {
    return lineAtOffset(this.s, offset) - 1
  }

  startOf(line: number): number {
    return this.s.lineOffsets[line] ?? this.s.text.length
  }

  line(i: number): string {
    return this.s.lines[i] ?? ''
  }
}

function tokensOf(start: number, end: number): number {
  return estimateTokens(end - start)
}

const LIST_LINE_RE = /^(?: {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)| {2,}\S|\t)/
const TABLE_LINE_RE = /^ {0,3}\|/

/** Nearest non-blank line from `i` in direction `step`, or -1. */
function nonBlank(d: DocLines, i: number, step: 1 | -1, lo: number, hi: number): number {
  for (let j = i; j >= lo && j <= hi; j += step) if (d.line(j).trim() !== '') return j
  return -1
}

/** A blank line that may separate two units: not inside a block, a table or a list. */
function isSplitLine(d: DocLines, i: number, lo: number, hi: number): boolean {
  if (d.line(i).trim() !== '' || d.lineClasses[i] !== null) return false
  const prev = nonBlank(d, i - 1, -1, lo, hi)
  const next = nonBlank(d, i + 1, 1, lo, hi)
  if (prev === -1 || next === -1) return false
  if (d.lineClasses[prev] !== null && d.lineClasses[next] !== null) return false
  const p = d.line(prev)
  const n = d.line(next)
  if (TABLE_LINE_RE.test(p) && TABLE_LINE_RE.test(n)) return false
  if (LIST_LINE_RE.test(p) && LIST_LINE_RE.test(n)) return false
  return true
}

/**
 * Paragraph blocks covering [start, end) exactly; blank lines stay with
 * the block before them. `start` and `end` are line starts (or the end of
 * the text).
 */
function paragraphBlocks(d: DocLines, start: number, end: number): Array<{ start: number, end: number }> {
  const first = d.lineOf(start)
  const last = end >= d.s.text.length ? d.s.lines.length - 1 : d.lineOf(end) - 1
  const blocks: Array<{ start: number, end: number }> = []
  let blockStart = start
  let sawText = false
  for (let i = first; i <= last; i++) {
    const blank = d.line(i).trim() === ''
    if (!blank && sawText && i > first && isSplitLine(d, i - 1, first, last)) {
      const at = d.startOf(i)
      if (at > blockStart) blocks.push({ start: blockStart, end: at })
      blockStart = at
    }
    if (!blank) sawText = true
  }
  if (end > blockStart) blocks.push({ start: blockStart, end })
  return blocks
}

const ATX_LINE_RE = /^ {0,3}#{1,6}(?:[ \t]|$)/
const SETEXT_UNDERLINE_RE = /^ {0,3}(?:=+|-{2,})[ \t]*$/

/** Whether a block is nothing but one heading (ATX, or setext text + underline). */
function isHeadingOnly(block: string): boolean {
  const lines = block.trim().split('\n')
  if (lines.length === 1) return ATX_LINE_RE.test(lines[0] ?? '')
  return lines.length === 2 && SETEXT_UNDERLINE_RE.test(lines[1] ?? '')
}

/** Attach blocks that are only a heading to the block after them (within the range). */
function attachHeadingBlocks(text: string, blocks: Array<{ start: number, end: number }>): Array<{ start: number, end: number }> {
  const out: Array<{ start: number, end: number }> = []
  let pending: { start: number, end: number } | null = null
  for (const b of blocks) {
    const merged: { start: number, end: number } = pending ? { start: pending.start, end: b.end } : b
    pending = null
    if (isHeadingOnly(text.slice(merged.start, merged.end))) {
      pending = merged
      continue
    }
    out.push(merged)
  }
  if (pending) out.push(pending)
  return out
}

/** Split [start, end) into spans of at most `max` tokens at paragraph boundaries (a single larger paragraph stays whole). */
function splitRun(d: DocLines, start: number, end: number, group: number, max: number): Span[] {
  if (tokensOf(start, end) <= max) return [{ start, end, group }]
  const spans: Span[] = []
  let cur: Span | null = null
  for (const b of paragraphBlocks(d, start, end)) {
    if (cur && tokensOf(cur.start, b.end) <= max) {
      cur.end = b.end
    } else {
      if (cur) spans.push(cur)
      cur = { start: b.start, end: b.end, group }
    }
  }
  if (cur) spans.push(cur)
  return spans
}

function childrenOf(s: DocumentStructure, sec: Section): Section[] {
  return s.sections.filter(c => c.parent === sec.index && c.level > 0)
}

/** Auto split of one section's subtree: whole when it fits, else its intro plus each child, recursively. */
function splitSection(d: DocLines, sec: Section, group: number, max: number): Span[] {
  if (tokensOf(sec.startOffset, sec.endOffset) <= max) return [{ start: sec.startOffset, end: sec.endOffset, group }]
  const kids = sec.level === 0 ? [] : childrenOf(d.s, sec)
  if (kids.length === 0) return splitRun(d, sec.startOffset, sec.endOffset, group, max)
  const spans = splitRun(d, sec.startOffset, sec.bodyEndOffset, sec.index, max)
  for (const kid of kids) spans.push(...splitSection(d, kid, sec.index, max))
  return spans
}

function mergeSmall(spans: Span[], min: number, max: number, acrossGroups: boolean): Span[] {
  const out: Span[] = []
  for (const sp of spans) {
    const acc = out.at(-1)
    const fits = acc !== undefined
      && (acrossGroups || acc.group === sp.group)
      && acc.end === sp.start
      && (tokensOf(acc.start, acc.end) < min || tokensOf(sp.start, sp.end) < min)
      && tokensOf(acc.start, sp.end) <= max
    if (fits) acc.end = sp.end
    else out.push({ ...sp })
  }
  return out
}

/**
 * Greedy packing of adjacent units up to `target` tokens: a unit takes the
 * next one (a sibling section, or the next section after the end of a
 * subtree) while the two together stay within the target. Runs after
 * `mergeSmall`, so it only joins whole units on their existing
 * boundaries (headings, safe blank lines).
 */
function packSiblings(spans: Span[], target: number): Span[] {
  const out: Span[] = []
  for (const sp of spans) {
    const acc = out.at(-1)
    if (acc && acc.end === sp.start && tokensOf(acc.start, sp.end) <= target) acc.end = sp.end
    else out.push({ ...sp })
  }
  return out
}

/** The top-level sections the targets name, in document order, without nested duplicates. */
function rootSections(s: DocumentStructure, targets: JobTargets): Section[] {
  if (targets === 'all') return s.sections.filter(sec => sec.level === 0 || sec.parent === null)
  const wanted = 'under' in targets ? [targets.under] : targets.sections
  const picked = [...new Set(wanted)]
    .map(i => s.sections[i])
    .filter((sec): sec is Section => sec !== undefined)
    .sort((a, b) => a.startOffset - b.startOffset)
  return picked.filter(sec => !picked.some(o => o !== sec && o.startOffset <= sec.startOffset && sec.endOffset <= o.endOffset && o.endOffset - o.startOffset > sec.endOffset - sec.startOffset))
}

/** Chapters: the roots, descending through a lone top heading (a title H1 over the whole document). */
function chapterSections(s: DocumentStructure, roots: Section[]): Array<{ start: number, end: number }> {
  const realRoots = roots.filter(r => r.level > 0)
  const lone = realRoots.length === 1 ? realRoots[0] : undefined
  const kids = lone ? childrenOf(s, lone) : []
  if (!lone || kids.length === 0) return roots.map(r => ({ start: r.startOffset, end: r.endOffset }))
  const out: Array<{ start: number, end: number }> = []
  for (const r of roots) {
    if (r !== lone) {
      out.push({ start: r.startOffset, end: r.endOffset })
      continue
    }
    if (lone.bodyEndOffset > lone.startOffset) out.push({ start: lone.startOffset, end: lone.bodyEndOffset })
    for (const k of kids) out.push({ start: k.startOffset, end: k.endOffset })
  }
  return out
}

/** Every section in the scope (roots and their descendants), in document order. */
function sectionsInScope(s: DocumentStructure, roots: Section[]): Section[] {
  return s.sections.filter(sec => roots.some(r => r.startOffset <= sec.startOffset && sec.endOffset <= r.endOffset))
}

function paragraphSpans(d: DocLines, roots: Section[]): Span[] {
  const spans: Span[] = []
  for (const sec of sectionsInScope(d.s, roots)) {
    const blocks = attachHeadingBlocks(d.s.text, paragraphBlocks(d, sec.startOffset, sec.bodyEndOffset))
    for (const b of blocks) spans.push({ ...b, group: sec.index })
  }
  return spans
}

function spansFor(d: DocLines, roots: Section[], opts: SplitOptions): Span[] {
  const max = opts.maxTokens ?? UNIT_MAX_TOKENS
  const min = opts.minTokens ?? UNIT_MIN_TOKENS
  if (opts.onlyMatching) {
    const re = opts.onlyMatching
    return paragraphSpans(d, roots).filter((sp) => {
      re.lastIndex = 0
      return re.test(d.s.text.slice(sp.start, sp.end))
    })
  }
  if (opts.mode === 'scan') {
    const spans = roots.flatMap(r => splitSection(d, r, -1, SCAN_UNIT_MAX_TOKENS))
    return mergeSmall(spans, SCAN_UNIT_MIN_TOKENS, SCAN_UNIT_MAX_TOKENS, true)
  }
  const granularity = opts.granularity === undefined || opts.granularity === 'auto'
    ? (opts.mode === 'summarise' ? 'chapter' : 'auto')
    : opts.granularity
  if (granularity === 'paragraph') return paragraphSpans(d, roots)
  if (granularity === 'section') {
    return sectionsInScope(d.s, roots).flatMap(sec => splitRun(d, sec.startOffset, sec.bodyEndOffset, sec.index, max))
  }
  if (granularity === 'chapter') {
    const chapterMax = opts.mode === 'summarise' ? SUMMARY_UNIT_MAX_TOKENS : CHAPTER_UNIT_MAX_TOKENS
    return chapterSections(d.s, roots).flatMap((c) => {
      if (tokensOf(c.start, c.end) <= chapterMax) return [{ ...c, group: -1 }]
      const sec = d.s.sections.find(x => x.startOffset === c.start && x.endOffset === c.end)
      return sec ? splitSection(d, sec, -1, chapterMax) : splitRun(d, c.start, c.end, -1, chapterMax)
    })
  }
  const spans = mergeSmall(roots.flatMap(r => splitSection(d, r, -1, max)), min, max, false)
  return PACKED_MODES.has(opts.mode) ? packSiblings(spans, Math.min(UNIT_TARGET_TOKENS, max)) : spans
}

/** Split `text` into the units of a job. Whitespace-only ranges are dropped. */
export function buildJobUnits(text: string, targets: JobTargets, opts: SplitOptions): JobUnit[] {
  const structure = parseSections(text)
  const d = new DocLines(structure)
  const roots = rootSections(structure, targets)
  const units: JobUnit[] = []
  for (const sp of spansFor(d, roots, opts)) {
    const unitText = text.slice(sp.start, sp.end)
    if (unitText.trim() === '') continue
    const firstTextLine = lineAtOffset(structure, sp.start + (unitText.length - unitText.trimStart().length))
    const sec = sectionAtLine(structure, firstTextLine)
    units.push({
      ordinal: units.length,
      headingPath: sec ? sec.headingPath : '(preamble)',
      start: sp.start,
      end: sp.end,
      text: unitText,
      tokens: estimateTokens(unitText.length),
      rev: shortHash(unitText)
    })
  }
  return units
}

/** Hash of a unit's text, as stored in `rev`. */
export function unitRev(text: string): string {
  return shortHash(text)
}

/** Read-only context around a unit: the last paragraph before it and the first after it, each at most `maxTokens`. */
export function unitContext(text: string, start: number, end: number, maxTokens = 300): { before: string, after: string } {
  const maxChars = Math.round(maxTokens * CHARS_PER_TOKEN)
  const beforeText = text.slice(0, start).trimEnd()
  const beforeParas = beforeText.split(/\n[ \t]*\n/)
  let before = beforeParas.at(-1) ?? ''
  if (before.length > maxChars) before = before.slice(before.length - maxChars)
  const afterText = text.slice(end).trimStart()
  let after = afterText.split(/\n[ \t]*\n/)[0] ?? ''
  if (after.length > maxChars) after = after.slice(0, maxChars)
  return { before, after }
}

/** The whitespace at the end of `text` (a unit keeps its own trailing newlines when replaced). */
export function trailingWhitespace(text: string): string {
  return text.slice(text.trimEnd().length)
}

/** The whitespace at the start of `text`. */
export function leadingWhitespace(text: string): string {
  return text.slice(0, text.length - text.trimStart().length)
}
