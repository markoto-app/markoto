import { describe, it, expect, vi } from 'vitest'
import * as Y from 'yjs'
import { nanoid } from 'nanoid'

import { executeFunctionByName } from '../../../server/utils/ai/tools/registry'
import type { AiSession } from '../../../server/utils/ai/aiClient'

// Stub workspaceAccess so canManageDoc returns false by default. The
// delete-auth tests rely on the AI's own-author / initiator's-own-author
// branches, not the doc-manager fallback. Hoisted to module top-level
// because vitest hoists vi.mock calls before any imports.
vi.mock('../../../server/utils/workspaces/workspaceAccess', () => ({
  canManageDoc: vi.fn().mockResolvedValue(false),
  canEditDoc: vi.fn().mockResolvedValue(true),
  getWorkspaceRole: vi.fn().mockResolvedValue(null),
  canManageWorkspace: vi.fn().mockResolvedValue(false),
  getDocAuthz: vi.fn().mockResolvedValue({ exists: true, ownerId: null, workspaceId: null, workspaceRole: null, accessMode: 'open-edit' })
}))

// Comment tool handlers — read_comments, create_comment, reply_to_comment,
// resolve_comment, delete_comment. These mutate the Y.js 'comments' array
// that the real-time UI renders, so correctness (authorId, anchorStart/End
// encoding, resolved flag, delete auth) is pinned here.

// Session stub (same pattern as aiToolAdapter.test.ts)

interface StubSession {
  session: AiSession
  ytext: Y.Text
  ydoc: Y.Doc
  statusCalls: Array<{ phase: string, message?: string }>
  originsSeen: Set<string>
}

function makeSession(initial = '', sessionId = 'test-session', initiatorUserId = 99): StubSession {
  const ydoc = new Y.Doc()
  const ytext = ydoc.getText('content')
  if (initial) ytext.insert(0, initial)

  const statusCalls: Array<{ phase: string, message?: string }> = []
  const originsSeen = new Set<string>()
  ydoc.on('afterTransaction', (tx) => {
    if (tx.origin != null) originsSeen.add(String(tx.origin))
  })

  const session = {
    ydoc,
    ytext,
    ymeta: ydoc.getMap('meta'),
    awareness: null as never,
    provider: null as never,
    sessionId,
    docId: 'doc-abc',
    initiatorUserId,
    workspaceId: null,
    attributedTo: `user:${initiatorUserId}` as never,
    plan: 'free' as never,
    periodStart: new Date(),
    updateStatus: vi.fn((phase: string, message?: string) => {
      statusCalls.push({ phase, message })
    }),
    destroy: async () => {}
  } as unknown as AiSession

  return { session, ytext, ydoc, statusCalls, originsSeen }
}

// Helpers to pre-seed comments into the Y.Doc

function seedComment(ydoc: Y.Doc, ytext: Y.Text, opts: {
  id?: string
  body?: string
  authorId?: number | null
  authorName?: string
  resolved?: boolean
  fromLine?: number
  toLine?: number
  replies?: Array<{ id?: string, body?: string, authorId?: number | null, authorName?: string }>
}): string {
  const id = opts.id ?? nanoid(12)
  const ycomments = ydoc.getArray<Y.Map<unknown>>('comments')
  const now = Date.now()

  // Build anchor positions from line range (simple offset calculation)
  const full = ytext.toString()
  const lines = full.split('\n')
  const fromLine = (opts.fromLine ?? 1) - 1 // 0-indexed
  const toLine = (opts.toLine ?? opts.fromLine ?? 1) - 1

  let startChar = 0
  for (let i = 0; i < fromLine && i < lines.length; i++) {
    startChar += lines[i]!.length + 1
  }
  let endChar = startChar
  for (let i = fromLine; i <= toLine && i < lines.length; i++) {
    endChar += lines[i]!.length + (i < toLine ? 1 : 0)
  }
  endChar = Math.max(endChar, startChar + 1) // ensure non-empty

  const startRel = Y.createRelativePositionFromTypeIndex(ytext, Math.min(startChar, ytext.length), 0)
  const endRel = Y.createRelativePositionFromTypeIndex(ytext, Math.min(endChar, ytext.length), -1)
  const anchorStart = Buffer.from(Y.encodeRelativePosition(startRel)).toString('base64')
  const anchorEnd = Buffer.from(Y.encodeRelativePosition(endRel)).toString('base64')

  const repliesArr = new Y.Array<Y.Map<unknown>>()
  for (const r of opts.replies ?? []) {
    const rMap = new Y.Map<unknown>()
    rMap.set('id', r.id ?? nanoid(12))
    rMap.set('body', r.body ?? 'reply body')
    rMap.set('authorId', r.authorId ?? null)
    rMap.set('authorName', r.authorName ?? 'AI Assistant')
    rMap.set('authorAvatarSeed', null)
    rMap.set('createdAt', now)
    rMap.set('updatedAt', now)
    repliesArr.push([rMap])
  }

  ydoc.transact(() => {
    const map = new Y.Map<unknown>()
    map.set('id', id)
    map.set('anchorStart', anchorStart)
    map.set('anchorEnd', anchorEnd)
    map.set('body', opts.body ?? 'test comment')
    map.set('authorId', opts.authorId ?? null)
    map.set('authorName', opts.authorName ?? 'AI Assistant')
    map.set('authorAvatarSeed', null)
    map.set('createdAt', now)
    map.set('updatedAt', now)
    map.set('resolved', opts.resolved ?? false)
    map.set('replies', repliesArr)
    ycomments.push([map])
  })

  return id
}

// read_comments

describe('read_comments', () => {
  it('returns empty message when no comments', async () => {
    const { session } = makeSession('hello world')
    const res = await executeFunctionByName(session, 'read_comments', {})
    expect(res.isError).toBe(false)
    expect(res.content).toContain('No comments')
  })

  it('returns thread count and id', async () => {
    const { session, ydoc, ytext } = makeSession('line one\nline two\nline three')
    const id = seedComment(ydoc, ytext, { fromLine: 1, toLine: 1, body: 'First comment' })
    const res = await executeFunctionByName(session, 'read_comments', {})
    expect(res.isError).toBe(false)
    expect(res.content).toContain('1 comment thread')
    expect(res.content).toContain(id)
    expect(res.content).toContain('First comment')
  })

  it('shows resolved status', async () => {
    const { session, ydoc, ytext } = makeSession('hello')
    seedComment(ydoc, ytext, { fromLine: 1, toLine: 1, resolved: true })
    const res = await executeFunctionByName(session, 'read_comments', {})
    expect(res.content).toContain('[RESOLVED]')
  })

  it('shows anchor text from the document', async () => {
    const { session, ydoc, ytext } = makeSession('hello world\nsecond line')
    seedComment(ydoc, ytext, { fromLine: 1, toLine: 1 })
    const res = await executeFunctionByName(session, 'read_comments', {})
    expect(res.content).toContain('hello world')
  })

  it('shows orphaned when anchor resolves to nothing', async () => {
    const { session, ydoc } = makeSession('')
    // Push a comment with corrupt anchor data
    const ycomments = ydoc.getArray<Y.Map<unknown>>('comments')
    ydoc.transact(() => {
      const map = new Y.Map<unknown>()
      map.set('id', 'orphan1')
      map.set('anchorStart', 'invaliddataz==')
      map.set('anchorEnd', 'invaliddataz==')
      map.set('body', 'orphaned comment')
      map.set('authorId', null)
      map.set('authorName', 'AI Assistant')
      map.set('authorAvatarSeed', null)
      map.set('createdAt', Date.now())
      map.set('updatedAt', Date.now())
      map.set('resolved', false)
      map.set('replies', new Y.Array())
      ycomments.push([map])
    })
    const res = await executeFunctionByName(session, 'read_comments', {})
    expect(res.content).toContain('[orphaned')
  })

  it('shows replies nested under thread', async () => {
    const { session, ydoc, ytext } = makeSession('hello')
    const commentId = seedComment(ydoc, ytext, {
      fromLine: 1,
      toLine: 1,
      replies: [{ id: 'reply1', body: 'this is a reply', authorName: 'Alice' }]
    })
    const res = await executeFunctionByName(session, 'read_comments', {})
    expect(res.content).toContain(commentId)
    expect(res.content).toContain('reply1')
    expect(res.content).toContain('this is a reply')
    expect(res.content).toContain('Alice')
  })

  it('strips mention tokens for display', async () => {
    const { session, ydoc, ytext } = makeSession('hello')
    seedComment(ydoc, ytext, {
      fromLine: 1,
      toLine: 1,
      body: 'Hey @[Joel](user:42) can you review this?'
    })
    const res = await executeFunctionByName(session, 'read_comments', {})
    expect(res.content).toContain('@Joel')
    expect(res.content).not.toContain('(user:42)')
  })
})

// create_comment

describe('create_comment', () => {
  it('creates a comment with AI identity and correct anchor', async () => {
    const { session, ydoc, ytext } = makeSession('line one\nline two\nline three')
    const res = await executeFunctionByName(session, 'create_comment', {
      start_line: 2,
      end_line: 2,
      body: 'this line needs work'
    })
    expect(res.isError).toBe(false)

    const ycomments = ydoc.getArray<Y.Map<unknown>>('comments')
    expect(ycomments.length).toBe(1)
    const map = ycomments.get(0)
    expect(map.get('authorId')).toBeNull()
    expect(map.get('authorName')).toBe('markoto')
    expect(map.get('body')).toBe('this line needs work')
    expect(map.get('resolved')).toBe(false)
    expect(typeof map.get('anchorStart')).toBe('string')
    expect(typeof map.get('anchorEnd')).toBe('string')
    // Replies array should be empty
    const replies = map.get('replies')
    expect(replies instanceof Y.Array).toBe(true)
    expect((replies as Y.Array<unknown>).length).toBe(0)

    // Verify the anchor resolves to the correct text
    const { session: _s2 } = makeSession('line one\nline two\nline three')
    // Copy ycomments entry into s2's ydoc to test anchor resolution independently
    const anchorStart = map.get('anchorStart') as string
    const anchorEnd = map.get('anchorEnd') as string
    const startRel = Y.decodeRelativePosition(new Uint8Array(Buffer.from(anchorStart, 'base64')))
    const endRel = Y.decodeRelativePosition(new Uint8Array(Buffer.from(anchorEnd, 'base64')))
    const startAbs = Y.createAbsolutePositionFromRelativePosition(startRel, ydoc)
    const endAbs = Y.createAbsolutePositionFromRelativePosition(endRel, ydoc)
    expect(startAbs).not.toBeNull()
    expect(endAbs).not.toBeNull()
    const anchorText = ytext.toString().slice(startAbs!.index, endAbs!.index)
    expect(anchorText).toContain('line two')
  })

  it('tags transaction origin with session id', async () => {
    const { session, originsSeen } = makeSession('hello\nworld', 'sess-xyz')
    await executeFunctionByName(session, 'create_comment', {
      start_line: 1,
      end_line: 1,
      body: 'test'
    })
    expect(originsSeen.has('ai:assistant:sess-xyz')).toBe(true)
  })

  it('errors when end_line < start_line', async () => {
    const { session } = makeSession('a\nb\nc')
    const res = await executeFunctionByName(session, 'create_comment', {
      start_line: 3,
      end_line: 1,
      body: 'bad range'
    })
    expect(res.isError).toBe(true)
    expect(res.content).toContain('end_line must be >= start_line')
  })

  it('errors when start_line is beyond EOF', async () => {
    const { session } = makeSession('only one line')
    const res = await executeFunctionByName(session, 'create_comment', {
      start_line: 99,
      end_line: 99,
      body: 'oob'
    })
    expect(res.isError).toBe(true)
    expect(res.content).toContain('beyond the end of the document')
  })

  it('anchors single-line and multi-line ranges', async () => {
    const { session, ydoc } = makeSession('alpha\nbeta\ngamma\ndelta')
    await executeFunctionByName(session, 'create_comment', {
      start_line: 2,
      end_line: 3,
      body: 'multi-line'
    })
    const ycomments = ydoc.getArray<Y.Map<unknown>>('comments')
    expect(ycomments.length).toBe(1)
  })
})

// reply_to_comment

describe('reply_to_comment', () => {
  it('adds a reply with AI identity and bumps parent updatedAt', async () => {
    const { session, ydoc, ytext } = makeSession('hello')
    const commentId = seedComment(ydoc, ytext, { fromLine: 1, toLine: 1 })
    const before = Date.now()

    const res = await executeFunctionByName(session, 'reply_to_comment', {
      comment_id: commentId,
      body: 'this is a reply'
    })
    expect(res.isError).toBe(false)

    const ycomments = ydoc.getArray<Y.Map<unknown>>('comments')
    const parentMap = ycomments.get(0)
    const repliesArr = parentMap.get('replies') as Y.Array<Y.Map<unknown>>
    expect(repliesArr.length).toBe(1)

    const reply = repliesArr.get(0)
    expect(reply.get('authorId')).toBeNull()
    expect(reply.get('authorName')).toBe('markoto')
    expect(reply.get('body')).toBe('this is a reply')

    expect((parentMap.get('updatedAt') as number)).toBeGreaterThanOrEqual(before)
  })

  it('errors when comment id does not exist', async () => {
    const { session } = makeSession('hello')
    const res = await executeFunctionByName(session, 'reply_to_comment', {
      comment_id: 'doesnotexist',
      body: 'reply'
    })
    expect(res.isError).toBe(true)
    expect(res.content).toContain('not found')
  })

  it('tags transaction origin correctly', async () => {
    const { session, ydoc, ytext, originsSeen } = makeSession('hello', 'sess-abc')
    const id = seedComment(ydoc, ytext, { fromLine: 1, toLine: 1 })
    await executeFunctionByName(session, 'reply_to_comment', {
      comment_id: id,
      body: 'hi'
    })
    expect(originsSeen.has('ai:assistant:sess-abc')).toBe(true)
  })
})

// resolve_comment

describe('resolve_comment', () => {
  it('marks a thread as resolved', async () => {
    const { session, ydoc, ytext } = makeSession('hello')
    const id = seedComment(ydoc, ytext, { fromLine: 1, toLine: 1, resolved: false })

    const res = await executeFunctionByName(session, 'resolve_comment', {
      comment_id: id,
      resolved: true
    })
    expect(res.isError).toBe(false)

    const ycomments = ydoc.getArray<Y.Map<unknown>>('comments')
    expect(ycomments.get(0).get('resolved')).toBe(true)
  })

  it('reopens a resolved thread', async () => {
    const { session, ydoc, ytext } = makeSession('hello')
    const id = seedComment(ydoc, ytext, { fromLine: 1, toLine: 1, resolved: true })

    const res = await executeFunctionByName(session, 'resolve_comment', {
      comment_id: id,
      resolved: false
    })
    expect(res.isError).toBe(false)

    const ycomments = ydoc.getArray<Y.Map<unknown>>('comments')
    expect(ycomments.get(0).get('resolved')).toBe(false)
  })

  it('errors when comment id does not exist', async () => {
    const { session } = makeSession('hello')
    const res = await executeFunctionByName(session, 'resolve_comment', {
      comment_id: 'ghost',
      resolved: true
    })
    expect(res.isError).toBe(true)
    expect(res.content).toContain('not found')
  })

  it('applies with no authorization check (anyone can resolve)', async () => {
    // Thread authored by a different user — AI should still be able to resolve
    const { session, ydoc, ytext } = makeSession('content')
    const id = seedComment(ydoc, ytext, {
      fromLine: 1,
      toLine: 1,
      authorId: 77,
      authorName: 'Another User',
      resolved: false
    })

    const res = await executeFunctionByName(session, 'resolve_comment', {
      comment_id: id,
      resolved: true
    })
    expect(res.isError).toBe(false)
    const ycomments = ydoc.getArray<Y.Map<unknown>>('comments')
    expect(ycomments.get(0).get('resolved')).toBe(true)
  })
})

// delete_comment

describe('delete_comment', () => {
  it('deletes an AI-authored thread', async () => {
    const { session, ydoc, ytext } = makeSession('hello')
    const id = seedComment(ydoc, ytext, {
      fromLine: 1,
      toLine: 1,
      authorId: null,
      authorName: 'AI Assistant'
    })
    const ycomments = ydoc.getArray<Y.Map<unknown>>('comments')
    expect(ycomments.length).toBe(1)

    const res = await executeFunctionByName(session, 'delete_comment', { comment_id: id })
    expect(res.isError).toBe(false)
    expect(ycomments.length).toBe(0)
  })

  it('deletes a thread authored by the initiator user', async () => {
    const initiatorId = 42
    const { session, ydoc, ytext } = makeSession('hello', 'sess', initiatorId)
    const id = seedComment(ydoc, ytext, {
      fromLine: 1,
      toLine: 1,
      authorId: initiatorId,
      authorName: 'Joel'
    })
    const ycomments = ydoc.getArray<Y.Map<unknown>>('comments')

    const res = await executeFunctionByName(session, 'delete_comment', { comment_id: id })
    expect(res.isError).toBe(false)
    expect(ycomments.length).toBe(0)
  })

  it('rejects deleting another user\'s comment when no management rights', async () => {
    const { session, ydoc, ytext } = makeSession('hello', 'sess', 99)
    const id = seedComment(ydoc, ytext, {
      fromLine: 1,
      toLine: 1,
      authorId: 77,
      authorName: 'Someone Else'
    })

    const res = await executeFunctionByName(session, 'delete_comment', { comment_id: id })
    expect(res.isError).toBe(true)
    expect(res.content).toContain('cannot delete')
  })

  it('deletes an AI-authored reply within a thread', async () => {
    const { session, ydoc, ytext } = makeSession('hello')
    const commentId = seedComment(ydoc, ytext, {
      fromLine: 1,
      toLine: 1,
      replies: [
        { id: 'reply-to-delete', body: 'AI reply', authorId: null, authorName: 'AI Assistant' }
      ]
    })

    const res = await executeFunctionByName(session, 'delete_comment', {
      comment_id: commentId,
      reply_id: 'reply-to-delete'
    })
    expect(res.isError).toBe(false)

    const ycomments = ydoc.getArray<Y.Map<unknown>>('comments')
    // Thread should still exist
    expect(ycomments.length).toBe(1)
    const repliesArr = ycomments.get(0).get('replies') as Y.Array<Y.Map<unknown>>
    expect(repliesArr.length).toBe(0)
  })

  it('errors when reply_id does not exist', async () => {
    const { session, ydoc, ytext } = makeSession('hello')
    const commentId = seedComment(ydoc, ytext, { fromLine: 1, toLine: 1 })

    const res = await executeFunctionByName(session, 'delete_comment', {
      comment_id: commentId,
      reply_id: 'no-such-reply'
    })
    expect(res.isError).toBe(true)
    expect(res.content).toContain('not found')
  })

  it('errors when comment_id does not exist', async () => {
    const { session } = makeSession('hello')
    const res = await executeFunctionByName(session, 'delete_comment', {
      comment_id: 'ghost-comment'
    })
    expect(res.isError).toBe(true)
    expect(res.content).toContain('not found')
  })

  it('bumps parent updatedAt when deleting a reply', async () => {
    const { session, ydoc, ytext } = makeSession('hello')
    const commentId = seedComment(ydoc, ytext, {
      fromLine: 1,
      toLine: 1,
      replies: [{ id: 'r1', authorId: null, authorName: 'AI Assistant' }]
    })
    const before = Date.now()

    await executeFunctionByName(session, 'delete_comment', {
      comment_id: commentId,
      reply_id: 'r1'
    })

    const ycomments = ydoc.getArray<Y.Map<unknown>>('comments')
    expect((ycomments.get(0).get('updatedAt') as number)).toBeGreaterThanOrEqual(before)
  })
})
