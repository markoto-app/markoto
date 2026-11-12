import { docExists } from '../../repos/documents'
import { replaceCommentSnapshot, type CommentSnapshotRow } from '../../repos/comments'
import { system, type DocAccess } from '../../repos/proofs'
import { appendActivity, pruneActivity } from '../../repos/activity'
import { diffCommentsSnapshot } from '../../utils/documents/commentsSnapshotDiff'
import { normalizeAvatarSeed } from '../../../shared/utils/documents/awarenessUser'
import { commentsSnapshotBody } from '~~/shared/api/platform'
import { commentSnapshotEntry, type CommentSnapshotEntry } from '~~/shared/contracts/syncInternal'

// Internal endpoint called by the sync-server on every persisted save of a doc
// with a non-empty `comments` Y.Array. The body carries the FULL list of
// comment entries (root + replies); the doc's rows in `document_comments` are
// replaced atomically.
//
// Eventually consistent: the mirror lags live Y.js by the sync server's store
// interval, which is fine for its cross-doc queries (mention notifications,
// recent activity).
//
// Auth: X-Internal-Secret, enforced for all of /api/internal/** by
// server/middleware/auth.ts and again by the policy.

const MAX_ENTRIES_PER_DOC = 5000
const MAX_BODY_LENGTH = 8000 // the loosest comment cap, with headroom

interface ParsedBody {
  docId: string
  entries: CommentSnapshotEntry[]
  yjsDocIdBefore: number | null
  yjsDocIdAfter: number | null
}

export default defineApiHandler({
  access: allow.internal('secret'),
  body: commentsSnapshotBody,
  handler: async ({ body: input }) => {
    if (input.entries.length > MAX_ENTRIES_PER_DOC) throw apiError('request/too-large')
    const body: ParsedBody = {
      docId: input.docId,
      // One corrupt entry is skipped, not the snapshot.
      entries: input.entries.flatMap((e) => {
        const parsed = commentSnapshotEntry.safeParse(e)
        return parsed.success ? [parsed.data] : []
      }),
      yjsDocIdBefore: input.yjsDocIdBefore ?? null,
      yjsDocIdAfter: input.yjsDocIdAfter ?? null
    }

    // Anonymous / direct-URL docs without a DB row are skipped, as in the
    // activity endpoint.
    if (!(await docExists(body.docId))) return { ok: true, mirrored: false }

    const rows = body.entries.map(buildSnapshotRow)
    // The sync server saves what its authorised clients wrote to this document.
    const doc = system('sync-server').doc(body.docId)

    const events = diffCommentsSnapshot(await replaceCommentSnapshot(doc, rows), rows)
    await recordSnapshotEvents(doc, body, events, anonAvatarSeedsByEntry(body.entries))

    return { ok: true, mirrored: true, rowCount: rows.length, activityEvents: events.length }
  }
})

/** One parsed entry as a mirror row, its text capped to the column limits. */
function buildSnapshotRow(e: CommentSnapshotEntry): CommentSnapshotRow {
  return {
    entryId: e.entryId,
    parentCommentId: e.parentCommentId,
    authorId: e.authorId,
    authorName: e.authorName.slice(0, 200),
    body: e.body.slice(0, MAX_BODY_LENGTH),
    createdAt: new Date(e.createdAt),
    updatedAt: new Date(e.updatedAt),
    resolved: e.resolved
  }
}

/**
 * Anonymous authors' avatar tokens by comment id, for the activity rows only
 * (the mirror table doesn't store them; they live on the comment in Y.js). A
 * deleted comment has none, so its row falls back to the name-seeded avatar.
 */
function anonAvatarSeedsByEntry(entries: CommentSnapshotEntry[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const e of entries) {
    if (e.authorId !== null) continue
    const seed = normalizeAvatarSeed(e.authorAvatarSeed)
    if (seed) out.set(e.entryId, seed)
  }
  return out
}

/** Build the activity-row metadata for a snapshot event by kind. */
function metadataForEvent(e: ReturnType<typeof diffCommentsSnapshot>[number]) {
  if (e.kind === 'comment.replied') {
    return { kind: e.kind, commentId: e.commentId, parentCommentId: e.parentCommentId, bodyPreview: e.bodyPreview }
  }
  if (e.kind === 'comment.deleted') {
    return { kind: e.kind, commentId: e.commentId, bodyPreview: e.bodyPreview, isReply: e.isReply }
  }
  return { kind: e.kind, commentId: e.commentId, bodyPreview: e.bodyPreview }
}

/** Append one activity row per snapshot event, then prune. */
async function recordSnapshotEvents(
  doc: DocAccess<'write'>,
  body: ParsedBody,
  events: ReturnType<typeof diffCommentsSnapshot>,
  anonSeeds: Map<string, string>
): Promise<void> {
  for (const e of events) {
    const metadata = metadataForEvent(e)
    await appendActivity(doc, {
      userId: e.userId,
      userName: e.userName,
      actorAvatarSeed: e.userId === null ? anonSeeds.get(e.commentId) ?? null : null,
      action: e.kind,
      metadata,
      yjsDocIdBefore: body.yjsDocIdBefore,
      yjsDocIdAfter: body.yjsDocIdAfter
    })
  }
  if (events.length > 0) await pruneActivity(doc)
}
