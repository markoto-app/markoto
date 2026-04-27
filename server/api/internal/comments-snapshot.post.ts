import { matchesCurrentOrPrevious } from '../../../shared/utils/secrets'
import { docExists } from '../../repos/documents'
import { replaceCommentSnapshot, type CommentSnapshotRow } from '../../repos/comments'

// Internal endpoint called by the sync-server on every persisted save
// of a doc that has a non-empty `comments` Y.Array. The body carries
// the FULL list of comment-shaped entries (root + replies), and we
// replace the doc's rows in `document_comments` atomically.
//
// Eventually-consistent design: we accept that the mirror lags the
// live Y.js state by however long y-postgresql's batch flush takes
// (~200 updates or whatever the flushSize is set to). The mirror
// exists for cross-doc queries (mention notifications, recent
// activity) — none of those care about sub-second freshness.
//
// Auth: shared X-Internal-Secret header. Same shape as
// `internal/activity.post.ts`.

interface IncomingEntry {
  entryId?: string
  parentCommentId?: string | null
  authorId?: number | null
  authorName?: string
  body?: string
  createdAt?: number
  updatedAt?: number
  resolved?: boolean
}

const MAX_ENTRIES_PER_DOC = 5000
const MAX_BODY_LENGTH = 8000 // matches the loosest comment cap with headroom

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig()
  const providedSecret = getRequestHeader(event, 'x-internal-secret')

  if (!config.internalApiSecret) {
    throw createError({ statusCode: 500, message: 'Internal API secret not configured' })
  }
  if (!providedSecret || !matchesCurrentOrPrevious(
    providedSecret,
    config.internalApiSecret,
    config.internalApiSecretPrevious || undefined
  )) {
    throw createError({ statusCode: 401, message: 'Invalid internal secret' })
  }

  const body = await readBody(event) as {
    docId?: string
    entries?: IncomingEntry[]
  }

  if (!body.docId || typeof body.docId !== 'string') {
    throw createError({ statusCode: 400, message: 'Missing docId' })
  }
  if (!Array.isArray(body.entries)) {
    throw createError({ statusCode: 400, message: 'entries must be an array' })
  }
  if (body.entries.length > MAX_ENTRIES_PER_DOC) {
    throw createError({ statusCode: 413, message: 'Too many entries in snapshot' })
  }

  // Anonymous / direct-URL docs without a DB row are skipped — same
  // posture as the activity endpoint. The mirror only makes sense
  // alongside a real document row.
  if (!(await docExists(body.docId))) {
    return { ok: true, mirrored: false }
  }

  const rows: CommentSnapshotRow[] = []
  for (const e of body.entries) {
    if (typeof e.entryId !== 'string' || e.entryId.length === 0 || e.entryId.length > 64) continue
    if (typeof e.authorName !== 'string') continue
    if (typeof e.body !== 'string') continue
    if (typeof e.createdAt !== 'number' || typeof e.updatedAt !== 'number') continue
    rows.push({
      entryId: e.entryId,
      parentCommentId: typeof e.parentCommentId === 'string' && e.parentCommentId.length > 0 && e.parentCommentId.length <= 64
        ? e.parentCommentId
        : null,
      authorId: typeof e.authorId === 'number' ? e.authorId : null,
      authorName: e.authorName.slice(0, 200),
      body: e.body.slice(0, MAX_BODY_LENGTH),
      createdAt: new Date(e.createdAt),
      updatedAt: new Date(e.updatedAt),
      resolved: Boolean(e.resolved)
    })
  }

  await replaceCommentSnapshot(body.docId, rows)
  return { ok: true, mirrored: true, rowCount: rows.length }
})
