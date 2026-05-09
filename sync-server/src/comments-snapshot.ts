// Mirrors the doc's `comments` Y.Array to the app's Postgres mirror
// table on every persisted save. Fire-and-forget — a failed snapshot
// never blocks Y.js sync; the mirror is eventually-consistent by design
// (see schema.ts comments on `document_comments`).

import * as Y from 'yjs'
import { injectTraceHeaders } from './sentry'

const APP_URL = process.env.APP_URL
const INTERNAL_SECRET = process.env.INTERNAL_API_SECRET

interface SnapshotEntry {
  entryId: string
  parentCommentId: string | null
  authorId: number | null
  authorName: string
  body: string
  createdAt: number
  updatedAt: number
  resolved: boolean
}

/** Coerce a Y.Map field to a string with a fallback (Anonymous, '', etc.). */
function strField(map: Y.Map<unknown>, key: string, fallback: string): string {
  const v = map.get(key)
  return typeof v === 'string' ? v : fallback
}

/** Coerce a Y.Map field to a number with a fallback. Returns null when fallback is null. */
function numField<F extends number | null>(map: Y.Map<unknown>, key: string, fallback: F): number | F {
  const v = map.get(key)
  return typeof v === 'number' ? v : fallback
}

/**
 * Build one SnapshotEntry from a Y.Map carrying a comment-or-reply.
 * Returns null when the map is missing a required string `id` (corrupt
 * row — silently dropped from the snapshot rather than failing the
 * whole mirror).
 */
function entryFromMap(map: Y.Map<unknown>, parentCommentId: string | null): SnapshotEntry | null {
  const id = map.get('id')
  if (typeof id !== 'string') return null
  return {
    entryId: id,
    parentCommentId,
    authorId: numField(map, 'authorId', null),
    authorName: strField(map, 'authorName', 'Anonymous'),
    body: strField(map, 'body', ''),
    createdAt: numField(map, 'createdAt', 0),
    updatedAt: numField(map, 'updatedAt', 0),
    // Replies inherit thread state via parentCommentId; the resolved
    // column is meaningful only on the root. Caller drives this via the
    // parentCommentId arg — null for roots, set for replies.
    resolved: parentCommentId === null && Boolean(map.get('resolved'))
  }
}

/**
 * Walk the doc's `comments` Y.Array and derive a flat list of
 * snapshot entries (root + nested replies). Replies inherit
 * `parentCommentId` from their thread root.
 */
function deriveSnapshot(ydoc: Y.Doc): SnapshotEntry[] {
  const ycomments = ydoc.getArray<Y.Map<unknown>>('comments')
  const out: SnapshotEntry[] = []
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
 * to re-fetch it from y-postgresql.
 *
 * Optional `boundaries` carry the y-postgresql row ids around the
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
      }),
      signal: AbortSignal.timeout(8000)
    })
    if (res.ok) {
      lastShipped.set(docId, fingerprint)
    } else {
      console.warn(`[comments-snapshot] mirror returned ${res.status} for ${docId}`)
    }
  } catch (e) {
    console.warn(`[comments-snapshot] mirror failed for ${docId}:`, e instanceof Error ? e.message : e)
  }
}

/**
 * Drop the per-doc dedup cache. Call when the doc's last client
 * disconnects so we don't retain a fingerprint indefinitely.
 */
export function dropSnapshotCache(docId: string): void {
  lastShipped.delete(docId)
}
