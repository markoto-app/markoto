import { classifyMarkdown, classifyMarkdownCached, overlappingRange, type MaskClass } from './tools/sections/markdownMask'

// Deterministic em-dash filter for text the AI writes. The writing rules
// in the prompts forbid the em-dash (U+2014), but models still put one
// into table cells, ranges and asides now and then. Every AI edit tool and
// the delegated-job runner pass the NEW text through `filterEmDashes`
// before it enters the document; text the AI did not write is never
// passed in. Pure (explicit imports only).
//
// Rules, for each run of em-dashes outside code, math, URLs and link
// targets (the `classifyMarkdown` ranges are left alone):
// - first thing on a line, in a table cell or a list item (an empty
//   placeholder, a lone cell value): en-dash;
// - between digits (a year range, spaced or not): en-dash, no spaces;
// - at the end of a line or cell: removed with the spaces before it;
// - after punctuation (",", ";", ":", ".", "!", "?"): a space;
// - before punctuation: removed;
// - otherwise, between words: ", ".
// "---" and " -- " are left as they are: a "---" line is a thematic break
// or a table delimiter, and Markdown only turns them into dashes in prose
// with typography extensions this app does not enable.

export const EM_DASH = '\u2014'
const EN_DASH = '–'

export interface DashFilterResult {
  text: string
  /** Number of em-dash runs that were replaced. */
  replaced: number
}

export interface DashFilterOptions {
  /** Only dashes at offsets this returns true for are changed (e.g. the parts a worker added). */
  allow?: (offset: number) => boolean
}

const LIST_MARKER_RE = /^(?:[-*+]|\d{1,9}[.)])[ \t]+/
const TASK_BOX_RE = /^\[[ xX]\][ \t]+/

/** Whether `before` (the line up to the dash) is only indentation, quote marks and a list marker: the dash opens the line or item. */
function opensLine(before: string): boolean {
  let rest = before.trimStart()
  while (rest.startsWith('>')) rest = rest.slice(1).trimStart()
  rest = rest.replace(LIST_MARKER_RE, '').replace(TASK_BOX_RE, '')
  return rest === ''
}
const PUNCT_BEFORE_RE = /[,;:.!?]/
const PUNCT_AFTER_RE = /[,;:.!?)\]}]/
const DIGIT_RE = /\p{Nd}/u

interface Replacement { from: number, to: number, with: string }

/** Offset of the nearest unescaped `|` in [lo, hi) searching from `at` in direction `step`, or -1. */
function pipeAt(text: string, at: number, lo: number, hi: number, step: 1 | -1): number {
  for (let i = at; i >= lo && i < hi; i += step) {
    if (text[i] === '|' && text[i - 1] !== '\\') return i
  }
  return -1
}

function planReplacement(text: string, start: number, end: number): Replacement {
  const lineStart = text.lastIndexOf('\n', start - 1) + 1
  const nl = text.indexOf('\n', end)
  const lineEnd = nl === -1 ? text.length : nl
  // A table row: the segment is the cell around the dash.
  const leftPipe = pipeAt(text, start - 1, lineStart, lineEnd, -1)
  const rightPipe = pipeAt(text, end, lineStart, lineEnd, 1)
  const segStart = leftPipe === -1 ? lineStart : leftPipe + 1
  const segEnd = rightPipe === -1 ? lineEnd : rightPipe
  const before = text.slice(segStart, start)
  const after = text.slice(end, segEnd)
  const left = before.trimEnd()
  const right = after.trimStart()
  const spacesLeft = before.length - left.length
  const spacesRight = after.length - right.length
  const prev = left.at(-1) ?? ''
  const next = right[0] ?? ''

  const atSegmentStart = leftPipe === -1 ? opensLine(before) : left === ''
  if (atSegmentStart) return { from: start, to: end, with: EN_DASH }
  if (right === '') return { from: start - spacesLeft, to: end, with: '' }
  if (DIGIT_RE.test(prev) && DIGIT_RE.test(next)) return { from: start - spacesLeft, to: end + spacesRight, with: EN_DASH }
  if (PUNCT_BEFORE_RE.test(prev)) return { from: start - spacesLeft, to: end + spacesRight, with: ' ' }
  if (PUNCT_AFTER_RE.test(next)) return { from: start - spacesLeft, to: end + spacesRight, with: '' }
  return { from: start - spacesLeft, to: end + spacesRight, with: ', ' }
}

function filterWith(text: string, masks: ReturnType<typeof classifyMarkdown>, opts: DashFilterOptions): DashFilterResult {
  let out = ''
  let pos = 0
  let replaced = 0
  for (const m of text.matchAll(/\u2014+/g)) {
    const start = m.index
    const end = start + m[0].length
    if (start < pos) continue
    if (overlappingRange(masks, start, end)) continue
    if (opts.allow && !opts.allow(start)) continue
    const r = planReplacement(text, start, end)
    const from = Math.max(r.from, pos)
    out += text.slice(pos, from) + r.with
    pos = r.to
    replaced++
  }
  return { text: out + text.slice(pos), replaced }
}

/** Replace the em-dashes of AI-written Markdown (see the rules above). */
export function filterEmDashes(text: string, opts: DashFilterOptions = {}): DashFilterResult {
  if (!text.includes(EM_DASH)) return { text, replaced: 0 }
  return filterWith(text, classifyMarkdown(text), opts)
}

/** `filterEmDashes(text).text`. */
export function withoutEmDashes(text: string): string {
  return filterEmDashes(text).text
}

/** Block classes whose content is never prose: an edit landing inside one is left as written. */
const BLOCK_CLASSES: ReadonlySet<MaskClass> = new Set(['code_block', 'math', 'html_comment', 'frontmatter'])

/**
 * Filter text the AI writes into the document at `at` (a fragment such as
 * replace_text's new_str): left alone when that spot lies inside a code
 * block, a math block, an HTML comment or the front matter of `docText`,
 * where the fragment alone does not show it is code.
 */
export function filterEmDashesAt(docText: string, at: number, text: string): string {
  if (!text.includes(EM_DASH)) return text
  const r = overlappingRange(classifyMarkdownCached(docText), at, at + 1)
  if (r && BLOCK_CLASSES.has(r.cls) && r.start < at) return text
  return filterEmDashes(text).text
}
