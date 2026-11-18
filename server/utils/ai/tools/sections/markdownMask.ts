// Which character ranges of a Markdown document are not prose: code, math,
// link targets, URLs, heading anchors, HTML comments, front matter. The
// section parser skips heading-looking lines inside block ranges,
// search_document skips matches inside the classes it was told to exclude,
// and the edit and delegation steps reuse the same ranges so a rename or a
// rewrite never touches a code sample, a formula or a link target.
//
// The classification is line based and deliberately simple (no full
// CommonMark parser): fenced code (``` and ~~~), `$$` math blocks, HTML
// comments (also across lines), leading front matter, then per line inline
// code spans, inline math, link / image targets, autolinks, bare URLs,
// reference definitions and `{#id .class}` attribute blocks.

export type MaskClass
  /** Fenced code block, fence lines included. */
  = | 'code_block'
  /** Inline code span, backticks included. */
    | 'inline_code'
  /** `$$` block or inline `$...$` / `$$...$$` math. */
    | 'math'
  /** The target of a link or image: the text between `(` and `)` after `](`. */
    | 'link_target'
  /** Autolinks (`<https://...>`), bare URLs and the URL part of reference definitions. */
    | 'url'
  /** Attribute block such as a heading's `{#anchor .class}`. */
    | 'attribute'
  /** `<!-- ... -->`, also across lines. */
    | 'html_comment'
  /** Leading `---` front matter block. */
    | 'frontmatter'

export interface MaskRange {
  /** Character offset of the first masked character. */
  start: number
  /** Character offset after the last masked character. */
  end: number
  cls: MaskClass
}

/** Classes that are code-like (excluded by search_document's `excludeCode`). */
export const CODE_MASK_CLASSES: ReadonlySet<MaskClass> = new Set(['code_block', 'inline_code', 'math', 'html_comment', 'frontmatter'])
/** Classes that are link machinery (excluded by `excludeUrls`); link TEXT is not among them. */
export const URL_MASK_CLASSES: ReadonlySet<MaskClass> = new Set(['link_target', 'url', 'attribute'])

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/
const MATH_FENCE_RE = /^ {0,3}\$\$/
const FRONTMATTER_OPEN_RE = /^---[ \t]*$/
const FRONTMATTER_CLOSE_RE = /^(?:---|\.\.\.)[ \t]*$/

/** Block-level class of each line (the state the line starts in), or null for ordinary lines. */
export type LineClass = 'code_block' | 'math' | 'html_comment' | 'frontmatter' | null

export interface BlockScan {
  /** Per line (0-based): the block the line belongs to, null when it is ordinary Markdown. */
  lineClasses: LineClass[]
  /** Block ranges (character offsets), one per block. */
  ranges: MaskRange[]
}

/** Character offset of the start of every line. */
export function lineStartOffsets(lines: readonly string[]): number[] {
  const out: number[] = []
  let offset = 0
  for (const line of lines) {
    out.push(offset)
    offset += line.length + 1
  }
  return out
}

/** Whether a fence line closes the open fence `open` (same character, at least as long, nothing after it). */
function closesFence(line: string, open: string): boolean {
  const m = FENCE_RE.exec(line)
  const fence = m?.[1]
  if (!m || !fence) return false
  return fence[0] === open[0] && fence.length >= open.length && line.slice(m[0].length).trim() === ''
}

/** Lines and their offsets, with accessors that never return undefined. */
class LineTable {
  constructor(readonly lines: readonly string[], readonly offsets: readonly number[]) {}

  get count(): number {
    return this.lines.length
  }

  line(i: number): string {
    return this.lines[i] ?? ''
  }

  start(i: number): number {
    return this.offsets[i] ?? 0
  }

  end(i: number): number {
    return this.start(i) + this.line(i).length
  }

  /** First line at or after `from` that satisfies `test`, else the last line. */
  findFrom(from: number, test: (line: string) => boolean): { index: number, found: boolean } {
    for (let j = from; j < this.count; j++) {
      if (test(this.line(j))) return { index: j, found: true }
    }
    return { index: this.count - 1, found: false }
  }
}

interface BlockHit {
  /** Last line of the block. */
  last: number
  range: MaskRange
  /** Class of each line of the block (null: the line is not all inside it). */
  firstLineClass: LineClass
  restClass: LineClass
}

function frontMatterBlock(t: LineTable): BlockHit | null {
  if (t.count < 2 || !FRONTMATTER_OPEN_RE.test(t.line(0))) return null
  const close = t.findFrom(1, l => FRONTMATTER_CLOSE_RE.test(l))
  if (!close.found) return null
  return { last: close.index, range: { start: 0, end: t.end(close.index), cls: 'frontmatter' }, firstLineClass: 'frontmatter', restClass: 'frontmatter' }
}

function fencedBlock(t: LineTable, i: number): BlockHit | null {
  const fence = FENCE_RE.exec(t.line(i))?.[1]
  if (!fence) return null
  const close = t.findFrom(i + 1, l => closesFence(l, fence))
  return { last: close.index, range: { start: t.start(i), end: t.end(close.index), cls: 'code_block' }, firstLineClass: 'code_block', restClass: 'code_block' }
}

function mathBlock(t: LineTable, i: number): BlockHit | null {
  const line = t.line(i)
  if (!MATH_FENCE_RE.test(line)) return null
  const rest = line.trim().slice(2)
  // `$$ x $$` on one line is a one-line block.
  const last = rest.trim().length > 0 && rest.trimEnd().endsWith('$$')
    ? i
    : t.findFrom(i + 1, l => l.trimEnd().endsWith('$$')).index
  return { last, range: { start: t.start(i), end: t.end(last), cls: 'math' }, firstLineClass: 'math', restClass: 'math' }
}

function commentBlock(t: LineTable, i: number): BlockHit | null {
  const line = t.line(i)
  const open = line.indexOf('<!--')
  if (open === -1 || insideInlineCode(line, open)) return null
  const start = t.start(i) + open
  const startsLine = line.trim().startsWith('<!--')
  const closeInLine = line.indexOf('-->', open + 4)
  if (closeInLine !== -1) {
    const wholeLine = startsLine && closeInLine + 3 === line.trimEnd().length
    return { last: i, range: { start, end: t.start(i) + closeInLine + 3, cls: 'html_comment' }, firstLineClass: wholeLine ? 'html_comment' : null, restClass: null }
  }
  const close = t.findFrom(i + 1, l => l.includes('-->'))
  const end = close.found ? t.start(close.index) + t.line(close.index).indexOf('-->') + 3 : t.end(close.index)
  return { last: close.index, range: { start, end, cls: 'html_comment' }, firstLineClass: startsLine ? 'html_comment' : null, restClass: 'html_comment' }
}

/**
 * The block structure: fenced code, `$$` math blocks, HTML comments and
 * front matter. `lines` / `offsets` are the document split on `\n` and
 * each line's start offset.
 */
export function scanBlocks(lines: readonly string[], offsets: readonly number[]): BlockScan {
  const t = new LineTable(lines, offsets)
  const lineClasses: LineClass[] = lines.map(() => null)
  const ranges: MaskRange[] = []
  const record = (from: number, hit: BlockHit): number => {
    lineClasses[from] = hit.firstLineClass
    for (let k = from + 1; k <= hit.last; k++) lineClasses[k] = hit.restClass
    ranges.push(hit.range)
    return hit.last + 1
  }
  // Front matter only at the very start of the document.
  const front = frontMatterBlock(t)
  let i = front ? record(0, front) : 0
  while (i < t.count) {
    const hit = fencedBlock(t, i) ?? mathBlock(t, i) ?? commentBlock(t, i)
    i = hit ? record(i, hit) : i + 1
  }
  return { lineClasses, ranges }
}

/** Whether position `pos` of `line` falls inside an inline code span. */
function insideInlineCode(line: string, pos: number): boolean {
  return inlineCodeSpans(line).some(([s, e]) => pos >= s && pos < e)
}

/** Length of the run of `ch` starting at `i`. */
function runLength(line: string, i: number, ch: string): number {
  let n = 0
  while (line[i + n] === ch) n++
  return n
}

/** Start of the next run of exactly `n` backticks at or after `from`, or -1. */
function closingBackticks(line: string, from: number, n: number): number {
  let j = line.indexOf('`', from)
  while (j !== -1) {
    const m = runLength(line, j, '`')
    if (m === n) return j
    j = line.indexOf('`', j + m)
  }
  return -1
}

/** Inline code spans of one line as [start, end) column pairs. */
function inlineCodeSpans(line: string): Array<[number, number]> {
  const spans: Array<[number, number]> = []
  let i = line.indexOf('`')
  while (i !== -1) {
    const n = runLength(line, i, '`')
    const escaped = i > 0 && line[i - 1] === '\\'
    const close = escaped ? -1 : closingBackticks(line, i + n, n)
    if (close === -1) {
      i = line.indexOf('`', i + n)
    } else {
      spans.push([i, close + n])
      i = line.indexOf('`', close + n)
    }
  }
  return spans
}

const REFERENCE_DEF_RE = /^ {0,3}\[(?!\^)[^\]]{1,999}\]:[ \t]*/
const AUTOLINK_RE = /<[a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s<>]*>/g
const BARE_URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>]+/g
const ATTRIBUTE_RE = /\{[ \t]*(?:[#.][\w-]|[\w-]{1,99}=)[^{}\n]*\}/g

/** Whether [s, e) overlaps one of `taken`. */
function overlaps(taken: ReadonlyArray<[number, number]>, s: number, e: number): boolean {
  return taken.some(([ts, te]) => s < te && e > ts)
}

/** Where the inline math opened at `i` (with `open` dollars) closes, or -1. Pandoc rules. */
function inlineMathClose(line: string, i: number, open: number): number {
  for (let j = i + open; j < line.length; j++) {
    if (line[j] !== '$' || line[j - 1] === '\\') continue
    if (open === 2 && line[j + 1] !== '$') continue
    // No space before the closing `$`, and no digit straight after it ("$5 and $10" is money).
    const spaceBefore = /\s/.test(line[j - 1] ?? ' ')
    const digitAfter = open === 1 && /\d/.test(line[j + 1] ?? '')
    return spaceBefore || digitAfter ? -1 : j
  }
  return -1
}

/** Inline math spans `$...$` / `$$...$$` of one line, outside `taken`. */
function inlineMathSpans(line: string, taken: ReadonlyArray<[number, number]>): Array<[number, number]> {
  const spans: Array<[number, number]> = []
  let i = line.indexOf('$')
  while (i !== -1) {
    const open = line[i + 1] === '$' ? 2 : 1
    const first = line[i + open]
    // No space straight after the opening `$`.
    const opens = (i === 0 || line[i - 1] !== '\\') && !overlaps(taken, i, i + 1) && first !== undefined && !/\s/.test(first)
    const close = opens ? inlineMathClose(line, i, open) : -1
    if (close === -1) {
      i = line.indexOf('$', i + open)
    } else {
      spans.push([i, close + open])
      i = line.indexOf('$', close + open)
    }
  }
  return spans
}

/** End of a link target that starts at `from` (balanced parentheses), or -1. */
function linkTargetEnd(line: string, from: number): number {
  let depth = 1
  for (let j = from; j < line.length; j++) {
    const c = line[j]
    if (c === '\\') j++
    else if (c === '(') depth++
    else if (c === ')' && --depth === 0) return j
  }
  return -1
}

/** The `(target)` of every `[text](target)` / `![alt](target)` in a line, outside `taken`. */
function linkTargetSpans(line: string, taken: ReadonlyArray<[number, number]>): Array<[number, number]> {
  const spans: Array<[number, number]> = []
  let at = line.indexOf('](')
  while (at !== -1) {
    const end = overlaps(taken, at, at + 2) ? -1 : linkTargetEnd(line, at + 2)
    if (end > at + 2) spans.push([at + 2, end])
    at = line.indexOf('](', Math.max(at + 2, end + 1))
  }
  return spans
}

/** Push every match of a global regex as a span (cls) unless it overlaps what is taken. */
function regexSpans(line: string, re: RegExp, taken: Array<[number, number]>, out: Array<[number, number, MaskClass]>, cls: MaskClass, trimPunctuation = false): void {
  for (const m of line.matchAll(re)) {
    let end = m.index + m[0].length
    if (trimPunctuation) {
      while (end > m.index && /[.,;:!?'")\]]/.test(line[end - 1] ?? '')) end--
    }
    if (end <= m.index || overlaps(taken, m.index, end)) continue
    taken.push([m.index, end])
    out.push([m.index, end, cls])
  }
}

/** Inline ranges of one ordinary line, as [start, end, class] columns. */
function inlineRanges(line: string): Array<[number, number, MaskClass]> {
  const out: Array<[number, number, MaskClass]> = []
  const taken: Array<[number, number]> = []
  const add = (spans: Array<[number, number]>, cls: MaskClass): void => {
    for (const [s, e] of spans) {
      out.push([s, e, cls])
      taken.push([s, e])
    }
  }
  add(inlineCodeSpans(line), 'inline_code')
  const ref = REFERENCE_DEF_RE.exec(line)
  if (ref && ref[0].length < line.length && !overlaps(taken, ref[0].length, line.length)) add([[ref[0].length, line.length]], 'url')
  add(linkTargetSpans(line, taken), 'link_target')
  regexSpans(line, AUTOLINK_RE, taken, out, 'url')
  regexSpans(line, BARE_URL_RE, taken, out, 'url', true)
  regexSpans(line, ATTRIBUTE_RE, taken, out, 'attribute')
  add(inlineMathSpans(line, taken), 'math')
  return out
}

/**
 * Every non-prose range of `text`, sorted by start and not overlapping.
 * Block ranges (code, math, comments, front matter) come from
 * `scanBlocks`; inline ranges are found on the remaining lines (a line
 * that holds a one-line comment is still scanned for links outside it).
 */
export function classifyMarkdown(text: string): MaskRange[] {
  const lines = text.split('\n')
  const offsets = lineStartOffsets(lines)
  const blocks = scanBlocks(lines, offsets)
  const ranges: MaskRange[] = [...blocks.ranges]
  lines.forEach((line, i) => {
    if (blocks.lineClasses[i] !== null) return
    const lineStart = offsets[i] ?? 0
    for (const [s, e, cls] of inlineRanges(line)) {
      const start = lineStart + s
      const end = lineStart + e
      if (blocks.ranges.some(r => start < r.end && end > r.start)) continue
      ranges.push({ start, end, cls })
    }
  })
  return ranges.sort((a, b) => a.start - b.start || b.end - a.end)
}

/** Cached `classifyMarkdown` for the last text seen (tools call it on the same text repeatedly). */
let lastMaskText: string | null = null
let lastMask: MaskRange[] = []
export function classifyMarkdownCached(text: string): MaskRange[] {
  if (text !== lastMaskText) {
    lastMask = classifyMarkdown(text)
    lastMaskText = text
  }
  return lastMask
}

/**
 * The first range of `ranges` (sorted by start) that overlaps [start, end),
 * or null (binary search; the ranges do not overlap each other).
 */
export function overlappingRange(ranges: readonly MaskRange[], start: number, end: number): MaskRange | null {
  let lo = 0
  let hi = ranges.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if ((ranges[mid]?.start ?? Infinity) < end) lo = mid + 1
    else hi = mid
  }
  // ranges[0..lo) start before `end`. They do not overlap each other, so
  // only the last of them can still reach past `start`.
  const last = ranges[lo - 1]
  return last && last.end > start ? last : null
}
