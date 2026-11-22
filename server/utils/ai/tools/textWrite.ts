import type * as Y from 'yjs'
import { nanoid } from 'nanoid'
import { computeWordHunks } from './sections/ytextDiff'
import { anchorRange, suggestionsMap } from '../../../../shared/utils/suggestions/ySuggestions'
import { SUGGESTION_TEXT_MAX, SUGGESTIONS_PER_DOC_MAX, type SuggestionRecord } from '../../../../shared/utils/suggestions/record'

// Every change the AI makes to a document's text goes through `editText`.
//
// Editing mode: the callback writes the live Y.Text in one transaction
// with the AI's origin, as before.
//
// Suggesting mode (the user asked the AI to suggest, or the document
// requires suggestions of that user): the callback writes a plain copy of
// the text instead, and the difference between the copy and the live text
// is stored as suggestions, one per changed run of words, anchored on the
// live text. The document text itself does not change; a person accepts
// or rejects each suggestion. The tools keep their logic unchanged.
//
// Pure apart from the Y.js writes (no Nitro), so the job runner, MCP and
// unit tests use it as is.

/** What the tool callbacks write to: a Y.Text, or the copy in suggesting mode. */
export interface TextTarget {
  insert(index: number, text: string): void
  delete(index: number, length: number): void
  readonly length: number
  toString(): string
  toJSON(): string
}

/** Who suggests, while the AI is in suggesting mode. */
export interface SuggestSink {
  /** The AI client's principal (`ai:assistant:<session>`, `ai-job:<job>`, `mcp:<session>`): accepting applies the change as it. */
  principal: string
  /** Shown on the card ("markoto"). */
  name: string
  /** Delegated job that suggests, so undoing the job removes its suggestions. */
  jobId?: string | null
  /** True when the document requires suggestions of the user: settings (title, theme) are off limits too. */
  forced: boolean
  /** Suggestions written so far (tool results report it). */
  written: number
}

export interface TextWriteContext {
  ydoc: Y.Doc
  ytext: Y.Text
  suggestSink?: SuggestSink | null
}

/** Colour of the AI's suggestion marks (shu, the AI's seal; the editor draws AI suggestions in it whatever is stored). */
const AI_SUGGESTION_COLOR = '#C8442C'

export class SuggestionLimitError extends Error {
  constructor(readonly reason: 'too-long' | 'too-many') {
    super(reason === 'too-long'
      ? `One suggested change can be at most ${SUGGESTION_TEXT_MAX} characters; make smaller changes.`
      : `The document already has ${SUGGESTIONS_PER_DOC_MAX} open suggestions; ask the user to accept or reject some first.`)
    this.name = 'SuggestionLimitError'
  }
}

/** A string that records `insert` / `delete` like a Y.Text, for suggesting mode. */
class TextCopy implements TextTarget {
  constructor(public text: string) {}

  get length(): number {
    return this.text.length
  }

  insert(index: number, text: string): void {
    const i = Math.max(0, Math.min(index, this.text.length))
    this.text = this.text.slice(0, i) + text + this.text.slice(i)
  }

  delete(index: number, length: number): void {
    const i = Math.max(0, Math.min(index, this.text.length))
    this.text = this.text.slice(0, i) + this.text.slice(Math.min(this.text.length, i + Math.max(0, length)))
  }

  toString(): string {
    return this.text
  }

  toJSON(): string {
    return this.text
  }
}

export interface Hunk {
  /** Offset in the old text. */
  from: number
  to: number
  text: string
}

const WS = /\s/

/**
 * The changed runs of words between two texts, in old-text offsets. The
 * common prefix and suffix are cut first (widened to whitespace, so a
 * changed word is diffed whole), then the middle is diffed word by word.
 */
export function changedRuns(oldText: string, newText: string): Hunk[] {
  if (oldText === newText) return []
  let start = 0
  const max = Math.min(oldText.length, newText.length)
  while (start < max && oldText.charCodeAt(start) === newText.charCodeAt(start)) start++
  let endOld = oldText.length
  let endNew = newText.length
  while (endOld > start && endNew > start && oldText.charCodeAt(endOld - 1) === newText.charCodeAt(endNew - 1)) {
    endOld--
    endNew--
  }
  while (start > 0 && !WS.test(oldText.charAt(start - 1))) start--
  while (endOld < oldText.length && endNew < newText.length && !WS.test(oldText.charAt(endOld))) {
    endOld++
    endNew++
  }
  const hunks = computeWordHunks(oldText.slice(start, endOld), newText.slice(start, endNew))
  return hunks.map(h => ({ from: start + h.offset, to: start + h.offset + h.deleteLength, text: h.insertText }))
}

/** Store `hunks` (offsets of the live text) as suggestions of `sink`. Inside the caller's transaction. */
export function writeSuggestions(ydoc: Y.Doc, ytext: Y.Text, hunks: readonly Hunk[], sink: SuggestSink, groupId: string): number {
  const map = suggestionsMap(ydoc)
  if (map.size + hunks.length > SUGGESTIONS_PER_DOC_MAX) throw new SuggestionLimitError('too-many')
  const live = ytext.toString()
  const now = Date.now()
  for (const h of hunks) {
    const deleted = live.slice(h.from, h.to)
    if (h.text.length > SUGGESTION_TEXT_MAX || deleted.length > SUGGESTION_TEXT_MAX) throw new SuggestionLimitError('too-long')
  }
  for (const h of hunks) {
    const id = nanoid(16)
    const record: SuggestionRecord = {
      v: 1,
      id,
      ...anchorRange(ytext, h.from, h.to),
      text: h.text,
      deleted: live.slice(h.from, h.to),
      authorId: null,
      authorName: sink.name.slice(0, 120),
      authorAvatarSeed: null,
      authorPrincipal: sink.principal.slice(0, 120),
      color: AI_SUGGESTION_COLOR,
      createdAt: now,
      updatedAt: now,
      groupId: groupId.slice(0, 80),
      jobId: sink.jobId?.slice(0, 80) ?? null
    }
    map.set(id, record)
  }
  sink.written += hunks.length
  return hunks.length
}

export interface EditTextResult {
  /** Suggestions written (suggesting mode); null when the text was edited directly. */
  suggested: number | null
}

/**
 * Change the document text: directly, or as suggestions in suggesting
 * mode (see the header). `write` runs once against the target and must
 * not read the live Y.Text for positions after its first write.
 */
export function editText(ctx: TextWriteContext, origin: string, write: (text: TextTarget) => void, groupId?: string): EditTextResult {
  const sink = ctx.suggestSink
  if (!sink) {
    ctx.ydoc.transact(() => write(ctx.ytext), origin)
    return { suggested: null }
  }
  const before = ctx.ytext.toString()
  const copy = new TextCopy(before)
  write(copy)
  const hunks = changedRuns(before, copy.text)
  let n = 0
  if (hunks.length > 0) {
    ctx.ydoc.transact(() => {
      n = writeSuggestions(ctx.ydoc, ctx.ytext, hunks, sink, groupId ?? nanoid(10))
    }, origin)
  }
  return { suggested: n }
}

/** Tool error for title / theme changes in suggesting mode. */
export const SETTINGS_NOT_SUGGESTIBLE = 'Error: suggestion mode is on, and document settings (title, theme) can\'t be suggested. Tell the user what you would change instead (message_to_user).'

/** The note a tool result gets in suggesting mode. */
export function suggestedNote(n: number): string {
  return n === 0
    ? 'Suggestion mode: nothing changed.'
    : `Suggestion mode: recorded as ${n} suggestion${n === 1 ? '' : 's'} for a person to accept or reject. The document text itself is unchanged until then, so do not make the same change again, and do not edit text you suggested to change.`
}
