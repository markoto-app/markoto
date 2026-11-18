import type { AgenticContent as Content, AgenticPart as Part } from '../aiTypes'
import { DOC_EDIT_TOOLS } from '../editProgress'
import {
  PRUNE_BATCH_CHARS,
  PRUNE_KEEP_RECENT_TURNS,
  PRUNE_LARGE_RESULT_CHARS,
  PRUNE_SUPERSEDED_MIN_CHARS
} from '../limits'

// In-session pruning of old read results. Every model call resends the
// whole history, so a section read in turn 2 is paid for again on turns
// 3..20, and after an edit it is out of date anyway. Before each model call
// the loop replaces the `output` of old, large or superseded read results
// with a short stub. Rules:
// - only the reading tools below; never a tool-call's arguments (they replay
//   verbatim, `messageTranslation.ts`) and never an edit result;
// - never a result from the latest `PRUNE_KEEP_RECENT_TURNS` turns;
// - in batches: nothing changes until the prunable total passes
//   `PRUNE_BATCH_CHARS`, then everything prunable goes at once, so the
//   conversation prefix changes rarely (prompt-cache friendly);
// - the functionResponse part stays (id, name, isError), only its output
//   text becomes the stub, so the provider still pairs it with its call.

/** Read-only tools whose results are worth pruning. */
const PRUNABLE_READ_TOOLS: ReadonlySet<string> = new Set([
  'view_document',
  'read_section',
  'view_other_document',
  'search_document',
  'outline',
  'read_comments'
])

/** Reads of the current document: any later edit makes them stale. */
const CURRENT_DOC_READS: ReadonlySet<string> = new Set(['view_document', 'read_section', 'search_document', 'outline'])

const STUB_PREFIX = '[document text from turn '

/** The stub that replaces a pruned result. */
export function prunedStub(turn: number, stale: boolean): string {
  return stale
    ? `${STUB_PREFIX}${turn} removed to save space; it is out of date after your edits. Read the section again if you need it.]`
    : `${STUB_PREFIX}${turn} removed to save space. Read it again if you need it.]`
}

function isPruned(output: string): boolean {
  return output.startsWith(STUB_PREFIX)
}

interface ReadEntry {
  /** The functionResponse whose `response` gets the stub. */
  response: NonNullable<Part['functionResponse']>
  name: string
  output: string
  /** Model turn (1-based) whose call produced this result. */
  turn: number
  /** Position in the history, for "later than". */
  order: number
  key: string
}

function argsRecord(args: unknown): Record<string, unknown> {
  return typeof args === 'object' && args !== null ? args as Record<string, unknown> : {}
}

/** What a read covers: a later read with the same key supersedes it. */
function readKey(name: string, args: unknown): string {
  const a = argsRecord(args)
  if (name === 'read_section') return `read_section:${String(a.section ?? '')}:${String(a.offset_line ?? '')}`
  if (name === 'view_other_document') return `view_other_document:${String(a.doc_id ?? '')}:${JSON.stringify(a.view_range ?? null)}`
  return `${name}:${JSON.stringify(a)}`
}

function outputOf(part: Part): string | null {
  const response = part.functionResponse?.response
  if (!response || typeof response !== 'object') return null
  const output = (response as { output?: unknown }).output
  return typeof output === 'string' ? output : null
}

function isErrorResult(part: Part): boolean {
  const response = part.functionResponse?.response as { isError?: unknown } | undefined
  return response?.isError === true
}

interface HistoryScan {
  reads: ReadEntry[]
  /** Order of every successful document edit. */
  edits: number[]
  /** Number of the latest model turn. */
  lastTurn: number
}

/** Record one tool-result part: a successful edit, or a read that may be pruned. */
function noteResult(scan: HistoryScan, part: Part, argsById: ReadonlyMap<string, unknown>, turn: number, order: number): void {
  const fr = part.functionResponse
  if (!fr?.name || isErrorResult(part)) return
  if (DOC_EDIT_TOOLS.has(fr.name)) scan.edits.push(order)
  if (!PRUNABLE_READ_TOOLS.has(fr.name)) return
  const output = outputOf(part)
  if (output === null || isPruned(output)) return
  scan.reads.push({ response: fr, name: fr.name, output, turn, order, key: readKey(fr.name, fr.id ? argsById.get(fr.id) : undefined) })
}

function scanHistory(contents: Content[]): HistoryScan {
  const argsById = new Map<string, unknown>()
  const scan: HistoryScan = { reads: [], edits: [], lastTurn: 0 }
  let order = 0
  for (const message of contents) {
    const isModel = message.role === 'model'
    if (isModel) scan.lastTurn += 1
    for (const part of message.parts ?? []) {
      order += 1
      if (part.functionCall?.id) argsById.set(part.functionCall.id, part.functionCall.args)
      if (!isModel) noteResult(scan, part, argsById, scan.lastTurn, order)
    }
  }
  return scan
}

function editedAfter(scan: HistoryScan, read: ReadEntry): boolean {
  return CURRENT_DOC_READS.has(read.name) && scan.edits.some(e => e > read.order)
}

function readAgainLater(scan: HistoryScan, read: ReadEntry): boolean {
  return scan.reads.some(r => r.order > read.order && r.key === read.key)
}

export interface PruneResult {
  /** Characters removed from the history (output text minus stub). */
  prunedChars: number
  /** Results replaced by a stub. */
  prunedResults: number
}

/**
 * Replace prunable read results in `contents` with stubs (in place), but
 * only once their total passes `batchChars`. Returns what was removed.
 */
export function pruneReadResults(contents: Content[], batchChars: number = PRUNE_BATCH_CHARS): PruneResult {
  const scan = scanHistory(contents)
  const protectedFrom = scan.lastTurn - PRUNE_KEEP_RECENT_TURNS + 1
  const candidates = scan.reads.flatMap((read) => {
    if (read.turn >= protectedFrom) return []
    const stale = editedAfter(scan, read)
    const superseded = stale || readAgainLater(scan, read)
    const prunable = read.output.length >= PRUNE_LARGE_RESULT_CHARS
      || (superseded && read.output.length >= PRUNE_SUPERSEDED_MIN_CHARS)
    return prunable ? [{ read, stub: prunedStub(read.turn, stale) }] : []
  })
  const total = candidates.reduce((sum, c) => sum + c.read.output.length - c.stub.length, 0)
  if (total < batchChars) return { prunedChars: 0, prunedResults: 0 }
  for (const { read, stub } of candidates) {
    read.response.response = { ...read.response.response, output: stub }
  }
  return { prunedChars: total, prunedResults: candidates.length }
}
