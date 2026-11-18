import type * as Y from 'yjs'
import { resolveUnitRange } from '../jobs/runner'
import type { JobUnit } from '../jobs/units'
import { plainCommentText } from '../../agentic/commentTriggerPrompt'

// Pure helpers of the delegation tools (`delegateTools.ts`): which units a
// preview samples, how scan items from many chunks merge into one list,
// and how a comment-mode finding becomes `create_comment` arguments. No
// Nitro, no database: unit-tested on their own.

/** The unit id the planner sees ("u3" = the job's third unit, 1-based). */
export function unitIdOf(ordinal: number): string {
  return `u${ordinal + 1}`
}

/** A unit id ("u3", "3") back to its 0-based ordinal, or null. */
export function ordinalOfUnitId(id: string): number | null {
  const m = /^u?(\d{1,6})$/i.exec(id.trim())
  if (!m) return null
  const n = Number(m[1])
  return n >= 1 ? n - 1 : null
}

const HARD_UNIT_RE = /^(?:```|~~~|\|.*\||\$\$)/m

/**
 * Units for a preview of `n` samples: one typical (closest to the median
 * size), one hard (a code block, a table or display math), then the
 * largest of the rest. Ordinals in document order.
 */
export function pickPreviewUnits(units: readonly JobUnit[], n: number): number[] {
  if (n <= 0 || units.length === 0) return []
  const picked = new Set<number>()
  const sizes = units.map(u => u.tokens).sort((a, b) => a - b)
  const median = sizes[Math.floor(sizes.length / 2)] ?? 0
  const typical = [...units].sort((a, b) => Math.abs(a.tokens - median) - Math.abs(b.tokens - median) || a.ordinal - b.ordinal)[0]
  if (typical) picked.add(typical.ordinal)
  const hard = units.find(u => !picked.has(u.ordinal) && HARD_UNIT_RE.test(u.text))
  if (hard && picked.size < n) picked.add(hard.ordinal)
  for (const u of [...units].sort((a, b) => b.tokens - a.tokens || a.ordinal - b.ordinal)) {
    if (picked.size >= n) break
    picked.add(u.ordinal)
  }
  return [...picked].sort((a, b) => a - b)
}

export interface ScanItemInput {
  text: string
  example?: string
  headingPath: string
}

export interface AggregatedScanItem {
  text: string
  /** Occurrences in the scanned text (at least the chunks that reported it). */
  count: number
  /** Heading paths of the chunks that reported it (at most 3). */
  sections: string[]
  example: string | null
}

const COUNT_CAP = 999

function occurrences(haystack: string, needle: string): number {
  if (!needle) return 0
  let n = 0
  let at = haystack.indexOf(needle)
  while (at !== -1 && n < COUNT_CAP) {
    n += 1
    at = haystack.indexOf(needle, at + needle.length)
  }
  return n
}

function itemKey(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase()
}

/**
 * Merge the items every chunk reported: the same text (case and spacing
 * ignored) is one item, counted in `scannedText`, with the chunks it came
 * from and the first example. Most frequent first, at most `max`.
 */
export function aggregateScanItems(items: readonly ScanItemInput[], scannedText: string, max: number): { items: AggregatedScanItem[], distinct: number } {
  const byKey = new Map<string, { text: string, reports: number, sections: string[], example: string | null }>()
  for (const item of items) {
    const key = itemKey(item.text)
    if (!key) continue
    const hit = byKey.get(key)
    if (hit) {
      hit.reports += 1
      if (!hit.sections.includes(item.headingPath) && hit.sections.length < 3) hit.sections.push(item.headingPath)
      hit.example ??= item.example?.trim() || null
      continue
    }
    byKey.set(key, { text: item.text.trim(), reports: 1, sections: [item.headingPath], example: item.example?.trim() || null })
  }
  const merged = [...byKey.values()].map(v => ({
    text: v.text,
    count: Math.max(v.reports, occurrences(scannedText, v.text)),
    sections: v.sections,
    example: v.example
  }))
  merged.sort((a, b) => b.count - a.count || a.text.localeCompare(b.text))
  return { items: merged.slice(0, max), distinct: merged.length }
}

export interface FindingInput {
  quote: string
  issue: string
  suggestion?: string
  severity: 'low' | 'medium' | 'high'
}

export interface CreateCommentArgs {
  start_line: number
  end_line: number
  body: string
}

const COMMENT_BODY_MAX = 4000
const MENTION_RE = /@\[[^\]]*\]\([^)]*\)|@ai\b/gi

/** 1-based line number of `offset` in `text`. */
function lineAt(text: string, offset: number): number {
  let line = 1
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line += 1
  return line
}

/** The comment text of a finding: plain text, no mentions (a job never pings anyone or triggers the AI). */
export function findingCommentBody(f: FindingInput): string {
  const text = f.suggestion?.trim() ? `${f.issue.trim()} Suggestion: ${f.suggestion.trim()}` : f.issue.trim()
  return plainCommentText(text.replace(MENTION_RE, '')).replace(/\s{2,}/g, ' ').trim().slice(0, COMMENT_BODY_MAX)
}

/**
 * `create_comment` arguments for a comment-mode finding: anchored on the
 * lines of the quote when it occurs exactly once in the unit's current
 * text, else on the unit's first line (its heading). Null when the unit
 * no longer exists or the body would be empty.
 */
export function findingToCommentArgs(doc: { ydoc: Y.Doc, ytext: Y.Text }, unit: { startRel: string, endRel: string }, finding: FindingInput): CreateCommentArgs | null {
  const body = findingCommentBody(finding)
  if (!body) return null
  const range = resolveUnitRange(doc, unit.startRel, unit.endRel)
  if (!range) return null
  const full = doc.ytext.toString()
  const unitText = full.slice(range.start, range.end)
  const quote = finding.quote.trim()
  const first = quote ? unitText.indexOf(quote) : -1
  const unique = first !== -1 && unitText.indexOf(quote, first + 1) === -1
  // Skip leading blank lines so the fallback lands on the heading.
  const lead = unitText.length - unitText.trimStart().length
  const start = range.start + (unique ? first : lead)
  const end = unique ? start + quote.length - 1 : start
  return { start_line: lineAt(full, start), end_line: lineAt(full, Math.max(start, end)), body }
}
