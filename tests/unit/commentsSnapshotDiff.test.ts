import { describe, it, expect } from 'vitest'
import { diffCommentsSnapshot, type SnapshotEntry } from '../../server/utils/documents/commentsSnapshotDiff'

// Pure function — every test is an inputs → outputs assertion. Goal
// is to lock down the branching that turns "comment snapshot diffs"
// into "activity events": which kinds fire, what metadata they
// carry, when nothing fires.

function row(overrides: Partial<SnapshotEntry> & { entryId: string }): SnapshotEntry {
  return {
    parentCommentId: null,
    authorId: null,
    authorName: 'Anon',
    body: '',
    resolved: false,
    ...overrides
  }
}

describe('diffCommentsSnapshot', () => {
  it('returns no events when both snapshots are empty', () => {
    expect(diffCommentsSnapshot([], [])).toEqual([])
  })

  it('returns no events when both snapshots are identical', () => {
    const r = [row({ entryId: 'a', body: 'hi' })]
    expect(diffCommentsSnapshot(r, r)).toEqual([])
  })

  it('emits comment.added for a new thread root', () => {
    const events = diffCommentsSnapshot([], [row({ entryId: 'a', body: 'hello world', authorId: 1, authorName: 'Joel' })])
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      kind: 'comment.added',
      commentId: 'a',
      userId: 1,
      userName: 'Joel',
      bodyPreview: 'hello world'
    })
  })

  it('emits comment.replied (NOT comment.added) for a new entry with a parentCommentId', () => {
    const events = diffCommentsSnapshot(
      [row({ entryId: 'root' })],
      [row({ entryId: 'root' }), row({ entryId: 'reply', parentCommentId: 'root', body: 'agreed' })]
    )
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      kind: 'comment.replied',
      commentId: 'reply',
      parentCommentId: 'root',
      bodyPreview: 'agreed'
    })
  })

  it('truncates the bodyPreview at 200 chars', () => {
    const longBody = 'x'.repeat(500)
    const events = diffCommentsSnapshot([], [row({ entryId: 'a', body: longBody })])
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ kind: 'comment.added' })
    expect((events[0] as { bodyPreview: string }).bodyPreview).toHaveLength(200)
  })

  it('emits comment.resolved when a root flips false → true', () => {
    const events = diffCommentsSnapshot(
      [row({ entryId: 'a', resolved: false })],
      [row({ entryId: 'a', resolved: true })]
    )
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ kind: 'comment.resolved', commentId: 'a' })
  })

  it('emits comment.reopened when a root flips true → false', () => {
    const events = diffCommentsSnapshot(
      [row({ entryId: 'a', resolved: true })],
      [row({ entryId: 'a', resolved: false })]
    )
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ kind: 'comment.reopened', commentId: 'a' })
  })

  it('emits comment.deleted with isReply=false when a thread root is removed', () => {
    const events = diffCommentsSnapshot(
      [row({ entryId: 'a', body: 'gone' })],
      []
    )
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      kind: 'comment.deleted',
      commentId: 'a',
      isReply: false,
      bodyPreview: 'gone'
    })
  })

  it('emits comment.deleted with isReply=true when a reply is removed', () => {
    const events = diffCommentsSnapshot(
      [
        row({ entryId: 'root' }),
        row({ entryId: 'reply', parentCommentId: 'root', body: 'oops' })
      ],
      [row({ entryId: 'root' })]
    )
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      kind: 'comment.deleted',
      commentId: 'reply',
      isReply: true,
      bodyPreview: 'oops'
    })
  })

  it('does NOT emit any event for a body change (intentional — text edits are tracked separately)', () => {
    const events = diffCommentsSnapshot(
      [row({ entryId: 'a', body: 'before' })],
      [row({ entryId: 'a', body: 'after' })]
    )
    expect(events).toEqual([])
  })

  it('does NOT emit any event for an authorName change with no other diff', () => {
    // Defensive — author rename through some future tool shouldn't
    // produce activity rows on its own.
    const events = diffCommentsSnapshot(
      [row({ entryId: 'a', authorName: 'Old' })],
      [row({ entryId: 'a', authorName: 'New' })]
    )
    expect(events).toEqual([])
  })

  it('emits resolve event when body AND resolved both change in same cycle', () => {
    // Body changes are silent, but if resolved ALSO flipped we still
    // want the resolve event. Combined transitions shouldn't suppress
    // the part we DO track.
    const events = diffCommentsSnapshot(
      [row({ entryId: 'a', body: 'before', resolved: false })],
      [row({ entryId: 'a', body: 'after', resolved: true })]
    )
    expect(events).toHaveLength(1)
    expect(events[0].kind).toBe('comment.resolved')
  })

  it('handles a mixed cycle: add root + add reply + resolve different root + delete reply', () => {
    const prev = [
      row({ entryId: 'old-root' }),
      row({ entryId: 'old-reply', parentCommentId: 'old-root', body: 'will be deleted' }),
      row({ entryId: 'other-root', resolved: false })
    ]
    const curr = [
      row({ entryId: 'old-root' }),
      // 'old-reply' deleted
      row({ entryId: 'other-root', resolved: true }),
      // new root added
      row({ entryId: 'new-root', body: 'new' }),
      // new reply added on the existing 'other-root'
      row({ entryId: 'new-reply', parentCommentId: 'other-root', body: 'reply' })
    ]
    const events = diffCommentsSnapshot(prev, curr)
    // 4 total: resolve other-root, add new-root, reply on other-root,
    // delete old-reply. Order is insertion-iteration: new entries
    // first (in nowById iteration order), then deletions.
    expect(events).toHaveLength(4)

    const kinds = events.map(e => e.kind).sort()
    expect(kinds).toEqual(['comment.added', 'comment.deleted', 'comment.replied', 'comment.resolved'])

    const deleted = events.find(e => e.kind === 'comment.deleted')
    expect(deleted).toMatchObject({ commentId: 'old-reply', isReply: true })
  })

  it('emits comment.replied even when the parent is missing from both snapshots (orphan reply)', () => {
    // Defensive: the snapshot is just a flat list — we don't validate
    // parentCommentId points at something that exists. A reply to a
    // not-yet-replicated parent (clock skew?) still generates an
    // activity row pointed at the orphan parent id.
    const events = diffCommentsSnapshot(
      [],
      [row({ entryId: 'orphan', parentCommentId: 'ghost', body: 'whatever' })]
    )
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      kind: 'comment.replied',
      commentId: 'orphan',
      parentCommentId: 'ghost'
    })
  })

  it('does NOT emit when parentCommentId mutates on an existing entry (silent)', () => {
    // A reply moved under a different parent — visible only as a
    // parentCommentId field change. We don't track this transition.
    // Documenting current behavior so a future change knowingly
    // breaks this expectation.
    const events = diffCommentsSnapshot(
      [row({ entryId: 'r', parentCommentId: 'rootA', body: 'x' })],
      [row({ entryId: 'r', parentCommentId: 'rootB', body: 'x' })]
    )
    expect(events).toEqual([])
  })

  it('preserves authorId + authorName from the NEW snapshot on resolve flips', () => {
    // The "resolver" identity isn't tracked — we fall back to the
    // current comment's author. Pin the behavior so future work
    // (threading resolver name through the payload) doesn't silently
    // change attribution.
    const events = diffCommentsSnapshot(
      [row({ entryId: 'a', resolved: false, authorId: 5, authorName: 'Original' })],
      [row({ entryId: 'a', resolved: true, authorId: 5, authorName: 'Original' })]
    )
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ userId: 5, userName: 'Original' })
  })

  it('handles a root-and-reply both deleted in the same cycle', () => {
    // Each deletion produces its own event with the correct isReply
    // flag — the parent's deletion doesn't suppress the child's row.
    const events = diffCommentsSnapshot(
      [
        row({ entryId: 'root' }),
        row({ entryId: 'reply', parentCommentId: 'root' })
      ],
      []
    )
    expect(events).toHaveLength(2)
    const root = events.find(e => 'commentId' in e && e.commentId === 'root')
    const reply = events.find(e => 'commentId' in e && e.commentId === 'reply')
    expect(root).toMatchObject({ kind: 'comment.deleted', isReply: false })
    expect(reply).toMatchObject({ kind: 'comment.deleted', isReply: true })
  })

  it('emits add events in the iteration order of the new snapshot, deletes after', () => {
    // Useful for debugging — pin the per-cycle ordering so future
    // refactors don't quietly reorder events.
    const events = diffCommentsSnapshot(
      [row({ entryId: 'old' })],
      [
        row({ entryId: 'first-new', body: '1' }),
        row({ entryId: 'second-new', body: '2' })
      ]
    )
    expect(events.map(e => e.kind)).toEqual(['comment.added', 'comment.added', 'comment.deleted'])
    // Deletions come last regardless of where they appeared in prev.
    expect(events[2]).toMatchObject({ commentId: 'old', kind: 'comment.deleted' })
  })
})
