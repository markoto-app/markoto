import { classifyMarkdown } from '../tools/sections/markdownMask'

// Masking of a unit before it goes to a worker: everything that must
// survive byte for byte (code, math, link and image targets, reference
// definitions, autolinks and bare URLs, attribute blocks, footnote markers,
// HTML comments, raw HTML tags, `/api/files` references, front matter) is
// replaced by a numbered placeholder `⟦P1⟧`, `⟦P2⟧`, ... The worker keeps
// every placeholder exactly once; `unmaskText` puts the originals back.
// Link TEXT stays visible (`[text](⟦P7⟧)`) so it can be translated.
// Pure (explicit imports only), so an eval harness can import it.

export interface MaskResult {
  masked: string
  /** Original text per placeholder, in order: `placeholders[0]` is `⟦P1⟧`. */
  placeholders: string[]
}

const PLACEHOLDER_RE = /⟦P(\d{1,5})⟧/g

export function placeholderToken(n: number): string {
  return `⟦P${n}⟧`
}

const FOOTNOTE_MARKER_RE = /\[\^[^\]\s]{1,100}\]/g
const RAW_HTML_TAG_RE = /<\/?[A-Za-z][^<>\n]{0,500}>/g
const FILE_REF_RE = /\/api\/files\/[^\s)"'<>\]]+/g
/** Text that already looks like a placeholder is masked too, so unmasking is exact. */
const EXISTING_PLACEHOLDER_RE = /⟦[^⟧\n]{0,40}⟧/g
const REFERENCE_DEF_LINE_RE = /^ {0,3}\[(?!\^)[^\]]{1,999}\]:[^\n]*$/gm

interface Range { start: number, end: number }

function overlapsAny(sorted: readonly Range[], s: number, e: number): boolean {
  return sorted.some(r => s < r.end && e > r.start)
}

function addRegex(text: string, re: RegExp, ranges: Range[]): void {
  for (const m of text.matchAll(re)) {
    const s = m.index
    const e = s + m[0].length
    if (!overlapsAny(ranges, s, e)) ranges.push({ start: s, end: e })
  }
}

/** Non-overlapping ranges to mask, sorted by start. */
function maskRanges(text: string): Range[] {
  let ranges: Range[] = classifyMarkdown(text).map(r => ({ start: r.start, end: r.end }))
  // Whole reference definitions (label too) and placeholder look-alikes
  // replace the finer ranges inside them, unless they sit inside a larger
  // range (a code block).
  for (const re of [REFERENCE_DEF_LINE_RE, EXISTING_PLACEHOLDER_RE]) {
    for (const m of text.matchAll(re)) {
      const s = m.index
      const e = s + m[0].length
      if (ranges.some(r => s < r.end && e > r.start && (r.start < s || r.end > e))) continue
      ranges = ranges.filter(r => !(r.start >= s && r.end <= e))
      ranges.push({ start: s, end: e })
    }
  }
  addRegex(text, FOOTNOTE_MARKER_RE, ranges)
  addRegex(text, RAW_HTML_TAG_RE, ranges)
  addRegex(text, FILE_REF_RE, ranges)
  return ranges.filter(r => r.end > r.start).sort((a, b) => a.start - b.start)
}

/** Replace every protected range of `text` by a numbered placeholder. */
export function maskText(text: string): MaskResult {
  const placeholders: string[] = []
  let masked = ''
  let at = 0
  for (const r of maskRanges(text)) {
    masked += text.slice(at, r.start)
    placeholders.push(text.slice(r.start, r.end))
    masked += placeholderToken(placeholders.length)
    at = r.end
  }
  masked += text.slice(at)
  return { masked, placeholders }
}

/**
 * Put the originals back. Unknown placeholder numbers stay as they are
 * (the validator refuses such output before it is ever unmasked).
 */
export function unmaskText(masked: string, placeholders: readonly string[]): string {
  return masked.replace(PLACEHOLDER_RE, (whole, n: string) => placeholders[Number(n) - 1] ?? whole)
}

/** How often each placeholder number occurs in `text`. */
export function countPlaceholders(text: string): Map<number, number> {
  const counts = new Map<number, number>()
  for (const m of text.matchAll(PLACEHOLDER_RE)) {
    const n = Number(m[1])
    counts.set(n, (counts.get(n) ?? 0) + 1)
  }
  return counts
}

/** `text` without placeholders (for length ratios and language checks). */
export function stripPlaceholders(text: string): string {
  return text.replace(PLACEHOLDER_RE, '')
}
