import { diffArrays } from 'diff'
import type * as Y from 'yjs'

/**
 * Minimal word-level replacement of a Y.Text range.
 *
 * Replacing `ytext[start, end)` with a delete + insert of the whole range
 * would delete every character in it, so every comment anchor
 * (Y.RelativePosition) and remote cursor pointing into the range would
 * collapse onto the range edge. This helper trims the common prefix and
 * suffix, diffs the remaining middle word by word (Myers, via `diff`) and
 * applies only the changed hunks, back to front, so positions on unchanged
 * words keep pointing at the same characters.
 *
 * It does NOT open a transaction: the caller wraps it in its own
 * `ydoc.transact(..., origin)` so the whole tool call is one update with the
 * caller's origin. Pure (no Nitro), safe in unit tests and the MCP pool.
 */

export interface MinimalDiffResult {
  changed: boolean
  insertedChars: number
  deletedChars: number
}

/** Token edit distance past which the word diff gives up and replaces the middle wholesale. */
const MAX_EDIT_TOKENS = 4000

const WORD_CHAR_RE = /[\p{L}\p{N}_]/u
const SPACE_RE = /\s/

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}

/** The code point at `index` as a string ('' past the end). */
function codePointAt(text: string, index: number): string {
  const cp = text.codePointAt(index)
  return cp === undefined ? '' : String.fromCodePoint(cp)
}

function isWordChar(text: string, index: number): boolean {
  if (index < 0 || index >= text.length) return false
  const code = text.charCodeAt(index)
  if (isLowSurrogate(code) || isHighSurrogate(code)) return false
  return WORD_CHAR_RE.test(text.charAt(index))
}

function isSpace(text: string, index: number): boolean {
  return index >= 0 && index < text.length && SPACE_RE.test(text.charAt(index))
}

/**
 * Tokens for the word diff: a word (letters, digits, underscore) or one
 * other character, each with the whitespace in front of it; trailing
 * whitespace on its own. Gluing the leading space onto the word keeps the
 * token count low, so Myers prefers aligning real words over aligning
 * spaces (otherwise "a b c" -> "a x b" ties between keeping "b" and
 * rewriting it).
 */
function tokenize(text: string): string[] {
  const tokens: string[] = []
  let i = 0
  while (i < text.length) {
    const start = i
    while (isSpace(text, i)) i++
    if (i >= text.length) {
      tokens.push(text.slice(start))
      break
    }
    if (isWordChar(text, i)) {
      while (isWordChar(text, i)) i++
    } else {
      i += codePointAt(text, i).length
    }
    tokens.push(text.slice(start, i))
  }
  return tokens
}

/** Length of the common prefix, never ending between the halves of a surrogate pair. */
function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length)
  let i = 0
  while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) i++
  // Stopping right after a high surrogate means the low halves differ (or one
  // string ended mid-pair): keep the whole pair inside the changed middle.
  if (i > 0 && isHighSurrogate(a.charCodeAt(i - 1)) && !(i === a.length && i === b.length)) i--
  return i
}

/** Length of the common suffix (not overlapping `prefix`), never starting on a low surrogate. */
function commonSuffixLength(a: string, b: string, prefix: number): number {
  const max = Math.min(a.length, b.length) - prefix
  let i = 0
  while (i < max && a.charCodeAt(a.length - 1 - i) === b.charCodeAt(b.length - 1 - i)) i++
  if (i > 0 && isLowSurrogate(a.charCodeAt(a.length - i))) i--
  return i
}

interface Hunk {
  /** Offset into the old text (relative to the range start). */
  offset: number
  deleteLength: number
  insertText: string
}

/**
 * Common prefix and suffix lengths, snapped to token boundaries: a cut
 * inside a word would let the diff delete the tail of one word and keep the
 * head of another, and a cut after a space would separate the space from
 * the word it is glued to. Either moves anchors onto the wrong word.
 */
function tokenAlignedTrims(oldText: string, newText: string): { prefix: number, suffix: number } {
  let prefix = commonPrefixLength(oldText, newText)
  while (prefix > 0 && isWordChar(oldText, prefix - 1) && (isWordChar(oldText, prefix) || isWordChar(newText, prefix))) prefix--
  while (prefix > 0 && isSpace(oldText, prefix - 1)) prefix--
  let suffix = commonSuffixLength(oldText, newText, prefix)
  while (suffix > 0) {
    const at = oldText.length - suffix
    const splitsWord = isWordChar(oldText, at) && (isWordChar(oldText, at - 1) || isWordChar(newText, newText.length - suffix - 1))
    if (!splitsWord && !isSpace(oldText, at - 1) && !isLowSurrogate(oldText.charCodeAt(at))) break
    suffix--
  }
  return { prefix, suffix }
}

/** Merge a token diff into hunks (runs of removals and additions between kept tokens). */
function hunksFromChanges(changes: ReadonlyArray<{ value: string[], added: boolean, removed: boolean }>, start: number): Hunk[] {
  const hunks: Hunk[] = []
  let cursor = start
  let pending: Hunk | null = null
  for (const change of changes) {
    const text = change.value.join('')
    if (!change.added && !change.removed) {
      if (pending) hunks.push(pending)
      pending = null
      cursor += text.length
      continue
    }
    pending ??= { offset: cursor, deleteLength: 0, insertText: '' }
    if (change.removed) {
      pending.deleteLength += text.length
      cursor += text.length
    } else {
      pending.insertText += text
    }
  }
  if (pending) hunks.push(pending)
  return hunks
}

/** Word-level hunks turning `oldText` into `newText`. Exported for tests. */
export function computeWordHunks(oldText: string, newText: string): Hunk[] {
  if (oldText === newText) return []
  const { prefix, suffix } = tokenAlignedTrims(oldText, newText)
  const oldMid = oldText.slice(prefix, oldText.length - suffix)
  const newMid = newText.slice(prefix, newText.length - suffix)
  const whole = [{ offset: prefix, deleteLength: oldMid.length, insertText: newMid }]
  if (oldMid.length === 0 || newMid.length === 0) return whole
  const changes = diffArrays(tokenize(oldMid), tokenize(newMid), { maxEditLength: MAX_EDIT_TOKENS })
  if (!changes) return whole
  return hunksFromChanges(changes, prefix)
    .map(hunk => trimHunkWhitespace(oldText, hunk))
    .filter(h => h.deleteLength > 0 || h.insertText.length > 0)
}

/** Length of the whitespace run both strings share at their start (`fromEnd`: at their end). */
function sharedSpace(a: string, b: string, fromEnd: boolean): number {
  let n = 0
  while (n < a.length && n < b.length) {
    const i = fromEnd ? a.length - 1 - n : n
    const j = fromEnd ? b.length - 1 - n : n
    if (a.charAt(i) !== b.charAt(j) || !SPACE_RE.test(a.charAt(i))) break
    n++
  }
  return n
}

/** Keep whitespace both sides share at a hunk's edges (it is glued to tokens, not changed). */
function trimHunkWhitespace(oldText: string, hunk: Hunk): Hunk {
  const removedAll = oldText.slice(hunk.offset, hunk.offset + hunk.deleteLength)
  const lead = sharedSpace(removedAll, hunk.insertText, false)
  const removed = removedAll.slice(lead)
  const inserted = hunk.insertText.slice(lead)
  const tail = sharedSpace(removed, inserted, true)
  return { offset: hunk.offset + lead, deleteLength: removed.length - tail, insertText: inserted.slice(0, inserted.length - tail) }
}

/**
 * Replace `ytext[start, end)` with `newText` as a minimal word-level diff.
 * Call inside the caller's `ydoc.transact`.
 */
export function applyMinimalDiff(ytext: Y.Text, start: number, end: number, newText: string): MinimalDiffResult {
  const length = ytext.length
  const from = Math.max(0, Math.min(start, length))
  const to = Math.max(from, Math.min(end, length))
  const oldText = ytext.toString().slice(from, to)
  const hunks = computeWordHunks(oldText, newText)
  let insertedChars = 0
  let deletedChars = 0
  for (const hunk of [...hunks].reverse()) {
    const at = from + hunk.offset
    if (hunk.deleteLength > 0) {
      ytext.delete(at, hunk.deleteLength)
      deletedChars += hunk.deleteLength
    }
    if (hunk.insertText.length > 0) {
      ytext.insert(at, hunk.insertText)
      insertedChars += hunk.insertText.length
    }
  }
  return { changed: hunks.length > 0, insertedChars, deletedChars }
}
