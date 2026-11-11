// Pure diff between two comment snapshots — produces the activity
// events that should be emitted for the transition. Extracted from
// the comments-snapshot endpoint so it can be tested in isolation
// without mocking the database or HTTP layer.
//
// Inputs are flat lists of comment-shaped rows (one entry per root
// + one entry per reply, replies carrying `parentCommentId` pointing
// at their root). Both inputs come from the same authoritative
// source — the doc's `comments` Y.Array — so the only legitimate
// differences are: NEW entries (added since prev), DELETED entries
// (gone since prev), or resolved-flag flips on existing entries.
//
// Body edits are intentionally NOT tracked here. Edits to comment
// text fall under the regular doc-edit pathway (the y-text bumps
// when a Y.Map field changes), not under "comment activity". This
// keeps the activity log readable: 100 keystrokes inside a comment
// don't produce 100 rows.
//
// Event ordering: we emit added/replied/resolve/reopen events first
// (iterating the new snapshot), then deletes (iterating the prev
// snapshot). The activity log itself is timestamp-ordered at insert
// time, so per-cycle event ordering only matters when many events
// share the same `created_at` — in which case `id` ordering inside
// the DB takes over.

export interface SnapshotEntry {
  entryId: string
  parentCommentId: string | null
  authorId: number | null
  authorName: string
  body: string
  resolved: boolean
}

export type SnapshotEvent
  = | { kind: 'comment.added', userId: number | null, userName: string, commentId: string, bodyPreview: string }
    | { kind: 'comment.replied', userId: number | null, userName: string, commentId: string, parentCommentId: string, bodyPreview: string }
    | { kind: 'comment.resolved' | 'comment.reopened', userId: number | null, userName: string, commentId: string, bodyPreview: string }
    | { kind: 'comment.deleted', userId: number | null, userName: string, commentId: string, bodyPreview: string, isReply: boolean }

const BODY_PREVIEW_LIMIT = 200

/**
 * Compute the events to emit for the transition prev → curr. Pure
 * function: same inputs always produce the same outputs in the same
 * order. No DB, no clock, no side effects.
 */
export function diffCommentsSnapshot(
  prev: SnapshotEntry[],
  curr: SnapshotEntry[]
): SnapshotEvent[] {
  const prevById = new Map(prev.map(r => [r.entryId, r]))
  const nowById = new Map(curr.map(r => [r.entryId, r]))
  const events: SnapshotEvent[] = []

  // Added / resolved-flag flips. Iterate the NEW snapshot so events
  // come out in roughly the order the user sees them in the panel.
  for (const [entryId, c] of nowById) {
    const p = prevById.get(entryId)
    if (!p) {
      events.push(eventForNewEntry(entryId, c))
      continue
    }
    const flip = eventForResolvedFlip(entryId, p, c)
    if (flip) events.push(flip)
    // Body edits, parentCommentId mutations, and other field changes
    // are intentionally NOT tracked — see header comment.
  }

  // Deletions. Iterate prev and skip rows still in curr.
  for (const [entryId, p] of prevById) {
    if (nowById.has(entryId)) continue
    events.push(eventForDeletion(entryId, p))
  }

  return events
}

function preview(body: string): string {
  return body.slice(0, BODY_PREVIEW_LIMIT)
}

/** New row: `comment.replied` if it has a parent, `comment.added` otherwise. */
function eventForNewEntry(entryId: string, c: SnapshotEntry): SnapshotEvent {
  if (c.parentCommentId) {
    return {
      kind: 'comment.replied',
      userId: c.authorId,
      userName: c.authorName,
      commentId: entryId,
      parentCommentId: c.parentCommentId,
      bodyPreview: preview(c.body)
    }
  }
  return {
    kind: 'comment.added',
    userId: c.authorId,
    userName: c.authorName,
    commentId: entryId,
    bodyPreview: preview(c.body)
  }
}

/** Resolved flag flipped between prev and curr. Returns null when nothing changed. */
function eventForResolvedFlip(entryId: string, p: SnapshotEntry, c: SnapshotEntry): SnapshotEvent | null {
  if (c.resolved === p.resolved) return null
  return {
    kind: c.resolved ? 'comment.resolved' : 'comment.reopened',
    userId: c.authorId,
    userName: c.authorName,
    commentId: entryId,
    bodyPreview: preview(c.body)
  }
}

/**
 * Use the prev row's `parentCommentId` to set `isReply` so the UI
 * can render "deleted a reply" vs "deleted a comment" without
 * re-querying (the row is gone by now).
 */
function eventForDeletion(entryId: string, p: SnapshotEntry): SnapshotEvent {
  return {
    kind: 'comment.deleted',
    userId: p.authorId,
    userName: p.authorName,
    commentId: entryId,
    bodyPreview: preview(p.body),
    isReply: p.parentCommentId !== null
  }
}
