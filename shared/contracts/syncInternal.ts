// Bodies of the internal HTTP calls between the app and the sync server
// (both directions, `X-Internal-Secret`). One definition per call: the
// sender types its JSON with the schema's input, the receiver parses with
// the schema. The receivers tolerate a mistyped optional field (one bad
// field must not drop the whole call), so those fields `.catch` instead of
// failing.
import { z } from 'zod'

// ── app → sync server ───────────────────────────────────────────────────

/** POST /internal/notify-deleted: the document was deleted; flag and unload it. */
export const notifyDeletedBody = z.object({ docId: z.string() })
export type NotifyDeletedRequest = z.input<typeof notifyDeletedBody>

/** POST /internal/flush-document: store the document's pending edits now. */
export const flushDocumentBody = z.object({ docId: z.string().min(1) })
export type FlushDocumentRequest = z.input<typeof flushDocumentBody>

/**
 * POST /internal/kick-user: close a user's connections to these documents.
 * The user id is compared as a string (JWT payloads carry a number for a
 * signed-in user, a string for synthetic principals); non-string doc ids are
 * skipped.
 */
export const kickUserBody = z.object({
  userId: z.union([z.string(), z.number()]),
  docIds: z.array(z.unknown()).transform(ids => ids.filter((d): d is string => typeof d === 'string'))
})
export type KickUserRequest = { userId: number | string, docIds: string[] }

/**
 * POST /internal/reauth-document: refuse tokens issued before `notBefore`
 * (the app's clock, epoch seconds) and close the document's connections.
 */
export const reauthDocumentBody = z.object({
  docId: z.string().min(1),
  notBefore: z.number().int().positive()
})
export type ReauthDocumentRequest = z.input<typeof reauthDocumentBody>

// ── sync server → app ───────────────────────────────────────────────────

/**
 * One comment or reply of a document's `comments` Y.Array, as the sync server
 * mirrors it to POST /api/internal/comments-snapshot. An entry without its
 * required fields is dropped by the app (one corrupt entry can't block the
 * snapshot); a mistyped optional field falls back.
 */
export const commentSnapshotEntry = z.object({
  entryId: z.string().min(1).max(64),
  /** Set on replies (the thread root's id); null on roots. */
  parentCommentId: z.string().min(1).max(64).nullable().catch(null),
  authorId: z.number().nullable().catch(null),
  authorName: z.string(),
  /** Anonymous authors only: the random avatar token stored on the comment. */
  authorAvatarSeed: z.string().nullable().catch(null),
  body: z.string(),
  /** Epoch milliseconds. */
  createdAt: z.number(),
  updatedAt: z.number(),
  /** Meaningful on roots only; replies inherit the thread state. */
  resolved: z.boolean().catch(false)
})
export type CommentSnapshotEntry = z.output<typeof commentSnapshotEntry>

/**
 * POST /api/internal/comments-snapshot. Each entry must be an object (400
 * otherwise); its fields are parsed one by one by the handler.
 */
export const commentsSnapshotBody = z.object({
  docId: z.string().min(1),
  entries: z.array(z.record(z.string(), z.unknown())),
  yjsDocIdBefore: z.number().nullish().catch(null),
  yjsDocIdAfter: z.number().nullish().catch(null)
})
export type CommentsSnapshotRequest = {
  docId: string
  entries: CommentSnapshotEntry[]
  yjsDocIdBefore?: number | null
  yjsDocIdAfter?: number | null
}
