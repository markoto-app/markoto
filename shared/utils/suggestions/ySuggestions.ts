// Reading and writing suggestion records against a live Y.Doc: anchors
// (Y.js relative positions), resolution to current offsets, and applying
// an accepted suggestion to the text. Used by the editor, the app server
// (accept / reject, AI, MCP) and tests; not by the sync server (yjs import).
//
// Anchor conventions (the same as comments):
//   - start: assoc 0, bound to the first struck character, so text typed
//     by others in front of the range stays outside it;
//   - end:   assoc -1, bound to the last struck character, so text typed
//     right after the range stays outside it too.
//   An insertion stores one position (assoc 0, bound to the character after
//   it) as both start and end: it follows that character through edits.
import * as Y from 'yjs'
import { fromBase64, toBase64 } from 'lib0/buffer'
import { parseSuggestion, SUGGESTIONS_ROOT, type SuggestionRecord } from './record'

export const CONTENT_ROOT = 'content'

export function suggestionsMap(ydoc: Y.Doc): Y.Map<unknown> {
  return ydoc.getMap(SUGGESTIONS_ROOT)
}

function encode(rel: Y.RelativePosition): string {
  return toBase64(Y.encodeRelativePosition(rel))
}

/** Anchors for the range `from` .. `to` of `ytext` (equal offsets = an insertion point). */
export function anchorRange(ytext: Y.Text, from: number, to: number): { start: string, end: string } {
  const a = Math.max(0, Math.min(from, ytext.length))
  const b = Math.max(a, Math.min(to, ytext.length))
  const start = encode(Y.createRelativePositionFromTypeIndex(ytext, a, 0))
  if (a === b) return { start, end: start }
  return { start, end: encode(Y.createRelativePositionFromTypeIndex(ytext, b, -1)) }
}

function resolveOne(b64: string, ydoc: Y.Doc): number | null {
  try {
    const abs = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(fromBase64(b64)), ydoc)
    return abs ? abs.index : null
  } catch {
    return null
  }
}

export interface ResolvedRange {
  from: number
  to: number
}

/**
 * Current offsets of a suggestion's range, or null when an anchor can't be
 * decoded or resolved (a corrupt record). A range whose text was removed
 * by someone else collapses to an empty range at the place it was.
 */
export function resolveSuggestionRange(r: Pick<SuggestionRecord, 'start' | 'end'>, ydoc: Y.Doc): ResolvedRange | null {
  const from = resolveOne(r.start, ydoc)
  if (from === null) return null
  if (r.end === r.start) return { from, to: from }
  const to = resolveOne(r.end, ydoc)
  if (to === null) return null
  return { from, to: Math.max(from, to) }
}

export interface ResolvedSuggestion extends ResolvedRange {
  record: SuggestionRecord
  /** The suggestion no longer changes anything: its struck text is gone and it inserts nothing. */
  obsolete: boolean
  /** The struck text differs from the text the author saw. */
  changed: boolean
}

/** All valid suggestions of the document with their current ranges, in document order. */
export function readSuggestions(ydoc: Y.Doc): ResolvedSuggestion[] {
  const map = suggestionsMap(ydoc)
  const text = ydoc.getText(CONTENT_ROOT)
  const full = text.toString()
  const out: ResolvedSuggestion[] = []
  for (const [key, value] of map.entries()) {
    const record = parseSuggestion(value)
    if (!record || record.id !== key) continue
    const range = resolveSuggestionRange(record, ydoc)
    if (!range) continue
    const current = full.slice(range.from, range.to)
    out.push({
      ...range,
      record,
      obsolete: range.from === range.to && record.text.length === 0,
      changed: current !== record.deleted
    })
  }
  out.sort((a, b) => a.from - b.from || a.to - b.to || a.record.createdAt - b.record.createdAt)
  return out
}

export function getSuggestion(ydoc: Y.Doc, id: string): SuggestionRecord | null {
  const r = parseSuggestion(suggestionsMap(ydoc).get(id))
  return r && r.id === id ? r : null
}

/**
 * Apply a suggestion to the text and remove it, inside the caller's
 * transaction. Returns false when its anchors no longer resolve (the
 * record is removed then too). The range is what it is NOW: text others
 * added inside it is struck with it, text they removed is not restored.
 */
export function applySuggestion(ydoc: Y.Doc, r: SuggestionRecord): boolean {
  const text = ydoc.getText(CONTENT_ROOT)
  const range = resolveSuggestionRange(r, ydoc)
  suggestionsMap(ydoc).delete(r.id)
  if (!range) return false
  if (range.to > range.from) text.delete(range.from, range.to - range.from)
  if (r.text.length > 0) text.insert(range.from, r.text)
  return true
}

/**
 * The document text with suggestions applied (all, or those `include`
 * picks), without touching the document. For previews of "what accepting
 * would give" and for tests. Overlapping ranges are applied back to front;
 * a range overlapping one already applied is clipped to what is left.
 */
export function textWithSuggestions(text: string, suggestions: readonly ResolvedSuggestion[]): string {
  const sorted = [...suggestions].sort((a, b) => b.to - a.to || b.from - a.from)
  let out = text
  let floor = Number.POSITIVE_INFINITY
  for (const s of sorted) {
    const to = Math.min(s.to, floor)
    const from = Math.min(s.from, to)
    out = out.slice(0, from) + s.record.text + out.slice(to)
    floor = from
  }
  return out
}
