// A suggestion: a proposed change to a document's text that is shown but
// not applied until someone with edit rights accepts it.
//
// Suggestions live in the document's Y.Doc, in the root `Y.Map`
// `suggestions`: key = suggestion id, value = one plain JSON record (never a
// nested Y type). One record per map entry keeps every write a single Y.js
// item, so the sync server can validate it whole (author, shape, size)
// before applying it (`sync-server/src/update-guard.ts`).
//
// Every suggestion has the same shape: a range of the current text to
// strike (`start` .. `end`, Y.js relative positions) and a text inserted at
// the range's end. An insertion has an empty range, a deletion an empty
// text, a replacement both.
//
// No `yjs` import: the sync server loads this file (see sync-server/AGENTS.md).
import { z } from 'zod'

/** Name of the root `Y.Map` that holds the records. */
export const SUGGESTIONS_ROOT = 'suggestions'

/** Inserted or struck text of one suggestion. Longer edits are split or made in editing mode. */
export const SUGGESTION_TEXT_MAX = 20_000
/** Open suggestions per document. */
export const SUGGESTIONS_PER_DOC_MAX = 2_000
/** Encoded relative positions are ~10 bytes; the cap only stops abuse. */
const ANCHOR_MAX = 256

const id = z.string().regex(/^[\w-]{6,40}$/)
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/)

/**
 * The stored record. `strict` so a client can't smuggle extra payload
 * into every document's history.
 */
export const suggestionRecord = z.object({
  v: z.literal(1),
  id,
  /** Base64 Y.js relative position of the range start (assoc 0). */
  start: z.string().min(1).max(ANCHOR_MAX),
  /** Base64 Y.js relative position of the range end (assoc -1), equal to `start` for an insertion. */
  end: z.string().min(1).max(ANCHOR_MAX),
  /** Text inserted at the end of the range. */
  text: z.string().max(SUGGESTION_TEXT_MAX),
  /** The struck text as it was when the suggestion was made: shown when the range changed since. */
  deleted: z.string().max(SUGGESTION_TEXT_MAX),
  /** Signed-in author; null for anonymous visitors and the AI. */
  authorId: z.number().int().positive().nullable(),
  authorName: z.string().max(120),
  /** Anonymous authors only: their random avatar token. */
  authorAvatarSeed: z.string().regex(/^[A-Za-z0-9]{1,32}$/).nullable(),
  /** The AI's principal (`ai:assistant:<session>`, `ai-job:<job>`, `mcp:<session>`); null for people. */
  authorPrincipal: z.string().max(120).nullable(),
  /** Display colour of the author's marks. */
  color: hexColor,
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  /** Suggestions made by one AI edit (tool call, job unit) share a group, accepted or rejected together. */
  groupId: z.string().max(80).nullable(),
  /** Delegated AI edit that made it, so undoing the job removes it. */
  jobId: z.string().max(80).nullable()
}).strict()

export type SuggestionRecord = z.infer<typeof suggestionRecord>

/** A stored value read back, or null when it is not a valid record. */
export function parseSuggestion(value: unknown): SuggestionRecord | null {
  const r = suggestionRecord.safeParse(value)
  return r.success ? r.data : null
}

export type SuggestionKind = 'insert' | 'delete' | 'replace'

/** What a suggestion does, from its stored fields. */
export function suggestionKind(r: Pick<SuggestionRecord, 'text' | 'deleted'>, rangeLength: number = r.deleted.length): SuggestionKind {
  if (rangeLength === 0) return 'insert'
  return r.text.length === 0 ? 'delete' : 'replace'
}

/** True for suggestions written by an AI client rather than a person. */
export function isAiSuggestion(r: Pick<SuggestionRecord, 'authorPrincipal'>): boolean {
  return r.authorPrincipal !== null
}

/**
 * The key that groups one author's suggestions ("accept all from X"):
 * the AI is one author, people by account id, anonymous visitors by
 * avatar token.
 */
export function suggestionAuthorKey(r: Pick<SuggestionRecord, 'authorId' | 'authorPrincipal' | 'authorAvatarSeed' | 'authorName'>): string {
  if (r.authorPrincipal !== null) return 'ai'
  if (r.authorId !== null) return `user:${r.authorId}`
  return `anon:${r.authorAvatarSeed ?? r.authorName}`
}

/** Policy of one document: who must suggest instead of editing. */
export const suggestionPolicy = z.object({
  /** Everyone not exempt edits in suggesting mode. */
  required: z.boolean(),
  /** Workspace roles that keep editing directly while `required` is on. The owner always does. */
  exemptRoles: z.array(z.enum(['admin', 'editor'])).max(2),
  /** Signed-in viewers (workspace viewers, guests with a view share, open-view visitors) may suggest. */
  viewersMaySuggest: z.boolean()
}).strict()

export type SuggestionPolicy = z.infer<typeof suggestionPolicy>

export const DEFAULT_SUGGESTION_POLICY: SuggestionPolicy = { required: false, exemptRoles: ['admin'], viewersMaySuggest: false }

/** A stored policy read back; anything malformed reads as the default (off). */
export function readSuggestionPolicy(value: unknown): SuggestionPolicy {
  const r = suggestionPolicy.safeParse(value)
  return r.success ? r.data : DEFAULT_SUGGESTION_POLICY
}
