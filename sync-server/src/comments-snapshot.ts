// Mirrors the doc's `comments` Y.Array to the app's Postgres mirror
// table on every persisted save. Fire-and-forget — a failed snapshot
// never blocks Y.js sync; the mirror is eventually-consistent by design
// (see schema.ts comments on `document_comments`).

import * as Y from 'yjs'
import { injectTraceHeaders } from './sentry'
import { normalizeAvatarSeed } from '../../shared/utils/documents/awarenessUser'
import { readYComment } from '../../shared/utils/documents/yComment'
import type { CommentSnapshotEntry, CommentsSnapshotRequest } from '../../shared/contracts/syncInternal'
import { syncEnv } from './env'
import { useLogger } from './logger'

const log = useLogger('comments-snapshot')

const APP_URL = syncEnv().sync.appUrl
const INTERNAL_SECRET = syncEnv().auth.internalApiSecret

/**
 * Build one snapshot entry from a Y.Map carrying a comment-or-reply.
 * Returns null when the map is missing a required string `id` (corrupt
 * row — silently dropped from the snapshot rather than failing the
 * whole mirror).
 */
function entryFromMap(map: Y.Map<unknown>, parentCommentId: string | null): CommentSnapshotEntry | null {
  const c = readYComment(map)
  if (c.id === undefined) return null
  return {
    entryId: c.id,
    parentCommentId,
    authorId: c.authorId,
    authorName: c.authorName ?? 'Anonymous',
    authorAvatarSeed: c.authorId === null ? normalizeAvatarSeed(c.authorAvatarSeed) : null,
    body: c.body,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    // Replies inherit thread state via parentCommentId; the resolved
    // column is meaningful only on the root. Caller drives this via the
    // parentCommentId arg — null for roots, set for replies.
    resolved: parentCommentId === null && c.resolved
  }
}

/**
 * Walk the doc's `comments` Y.Array and derive a flat list of
 * snapshot entries (root + nested replies). Replies inherit
 * `parentCommentId` from their thread root.
 */
function deriveSnapshot(ydoc: Y.Doc): CommentSnapshotEntry[] {
  const ycomments = ydoc.getArray<Y.Map<unknown>>('comments')
  const out: CommentSnapshotEntry[] = []
  for (let i = 0; i < ycomments.length; i++) {
    const map = ycomments.get(i)
    if (!(map instanceof Y.Map)) continue
    const root = entryFromMap(map, null)
    if (!root) continue
    out.push(root)

    const repliesArr = map.get('replies')
    if (!(repliesArr instanceof Y.Array)) continue
    for (let j = 0; j < repliesArr.length; j++) {
      const r = repliesArr.get(j)
      if (!(r instanceof Y.Map)) continue
      const reply = entryFromMap(r, root.entryId)
      if (reply) out.push(reply)
    }
  }
  return out
}

/**
 * Per-doc dedup. We compare the freshly-derived snapshot to the last
 * one we shipped; if identical, we skip the round-trip entirely. Most
 * Y.js stores are content-only and don't touch the comments array, so
 * the dedup wipes out the vast majority of mirror calls.
 */
const lastShipped = new Map<string, string>()

/**
 * Best-effort. Errors are logged and swallowed; the mirror catches up
 * on the next store. Caller passes the Y.Doc directly so we don't have
 * to re-fetch it from the database.
 *
 * Optional `boundaries` carry the `yjs_updates` row ids around the
 * triggering store event — passed through so the comment.* activity
 * rows get the same diff-replay anchors as edit rows.
 */
export async function shipCommentsSnapshot(
  docId: string,
  ydoc: Y.Doc,
  boundaries?: { yjsDocIdBefore: number | null, yjsDocIdAfter: number | null }
): Promise<void> {
  if (!APP_URL || !INTERNAL_SECRET) return // dev setups can run without the mirror

  const entries = deriveSnapshot(ydoc)
  // Cheap content fingerprint — JSON.stringify of the small flat list
  // is fast enough at our scale (dozens-to-hundreds of comments).
  const fingerprint = JSON.stringify(entries)
  if (lastShipped.get(docId) === fingerprint) return

  try {
    const res = await fetch(`${APP_URL}/api/internal/comments-snapshot`, {
      method: 'POST',
      headers: injectTraceHeaders({
        'Content-Type': 'application/json',
        'X-Internal-Secret': INTERNAL_SECRET
      }),
      body: JSON.stringify({
        docId,
        entries,
        yjsDocIdBefore: boundaries?.yjsDocIdBefore ?? null,
        yjsDocIdAfter: boundaries?.yjsDocIdAfter ?? null
      } satisfies CommentsSnapshotRequest),
      signal: AbortSignal.timeout(8000)
    })
    if (res.ok) {
      lastShipped.set(docId, fingerprint)
    } else {
      log.warn('mirror returned an error status', { status: res.status, docId })
    }
  } catch (e) {
    log.warn('mirror failed', { docId, err: e })
  }
}

/**
 * Drop the per-doc dedup cache. Call when the doc's last client
 * disconnects so we don't retain a fingerprint indefinitely.
 */
export function dropSnapshotCache(docId: string): void {
  lastShipped.delete(docId)
}
