import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as Y from 'yjs'
import { anchorRange, readSuggestions, suggestionsMap } from '../../../shared/utils/suggestions/ySuggestions'
import type { SuggestionRecord } from '../../../shared/utils/suggestions/record'

// resolveSuggestions drives short-lived sync clients. Here every client is
// a view of one in-memory Y.Doc, recording which principal connected, so the
// attribution ("accept applies the text as the suggester") is observable.

const h = vi.hoisted(() => ({
  doc: null as unknown as import('yjs').Doc,
  principals: [] as string[],
  failThreadClient: false,
  activity: [] as Array<Record<string, unknown>>,
  flushed: 0,
  ids: [10, 20]
}))

vi.mock('../../../server/utils/documents/commentsServerClient', () => ({
  openTrustedCommentClient: vi.fn(async (_docId: string, principal: string, name: string) => {
    h.principals.push(`${principal}|${name}`)
    if (h.failThreadClient && h.principals.length > 1 && principal.startsWith('suggestions-server:')) throw new Error('boom')
    return {
      ydoc: h.doc,
      get ycomments() { return h.doc.getArray('comments') },
      acknowledged: async () => {},
      destroy: async () => {}
    }
  })
}))
vi.mock('../../../server/utils/documents/syncNotify', () => ({ flushSyncDocument: vi.fn(async () => {
  h.flushed++
}) }))
vi.mock('../../../server/repos/activity', () => ({
  appendActivity: vi.fn(async (_d: unknown, row: Record<string, unknown>) => { h.activity.push(row) }),
  pruneActivity: vi.fn(async () => {})
}))
vi.mock('../../../server/repos/yjsLog', () => ({ latestYjsId: vi.fn(async () => h.ids.shift() ?? 99) }))
vi.mock('../../../server/utils/platform/logger', () => ({ useLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }) }))
vi.stubGlobal('apiError', (code: string, data?: unknown) => Object.assign(new Error(code), { data: { code, ...(data as object) } }))

const { resolveSuggestions } = await import('../../../server/utils/suggestions/resolveSuggestions')

let n = 0
function suggest(from: number, to: number, text: string, over: Partial<SuggestionRecord> = {}): SuggestionRecord {
  const ytext = h.doc.getText('content')
  const id = `sugg-${String(++n).padStart(4, '0')}`
  const record: SuggestionRecord = {
    v: 1, id, ...anchorRange(ytext, from, to), text, deleted: ytext.toString().slice(from, to),
    authorId: 7, authorName: 'Bea', authorAvatarSeed: null, authorPrincipal: null, color: '#7A8C7E',
    createdAt: n, updatedAt: n, groupId: null, jobId: null, ...over
  }
  suggestionsMap(h.doc).set(id, record)
  return record
}

const doc = Object.assign(Object.create(null), { docId: 'doc1' }) as never
const reviewer = { userId: 1, name: 'Rae' }
const text = () => h.doc.getText('content').toString()

beforeEach(() => {
  h.doc = new Y.Doc()
  h.doc.getText('content').insert(0, 'The quick brown fox jumps')
  h.principals = []
  h.activity = []
  h.flushed = 0
  h.ids = [10, 20]
  h.failThreadClient = false
})

describe('resolveSuggestions', () => {
  it('accepts as the suggester and removes the record', async () => {
    const s = suggest(4, 9, 'slow')
    const r = await resolveSuggestions({ doc, reviewer, action: 'accept', select: { ids: [s.id] } })
    expect(r).toEqual({ resolved: 1, missing: 0 })
    expect(text()).toBe('The slow brown fox jumps')
    expect(readSuggestions(h.doc)).toHaveLength(0)
    // reviewer reads, the author's own principal applies, reviewer closes threads
    expect(h.principals[0]).toBe('suggestions-server:accept:1|Rae')
    expect(h.principals[1]).toBe('7|Bea')
    expect(h.principals).toHaveLength(3)
  })

  it('applies an AI suggestion under its own principal and anonymous ones as "anonymous"', async () => {
    suggest(0, 3, 'A', { authorPrincipal: 'ai:assistant:s1', authorId: null, authorName: 'markoto' })
    suggest(10, 15, 'red', { authorId: null, authorName: 'Anon', authorAvatarSeed: 'abc' })
    const r = await resolveSuggestions({ doc, reviewer, action: 'accept', select: {} })
    expect(r.resolved).toBe(2)
    expect(text()).toBe('A quick red fox jumps')
    expect(h.principals).toContain('ai:assistant:s1|markoto')
    expect(h.principals).toContain('anonymous|Anon')
  })

  it('accepts several of one author back to front so positions stay valid', async () => {
    suggest(0, 3, 'A')
    suggest(4, 9, 'slow')
    const r = await resolveSuggestions({ doc, reviewer, action: 'accept', select: { authorKey: 'user:7' } })
    expect(r.resolved).toBe(2)
    expect(text()).toBe('A slow brown fox jumps')
    expect(h.principals.filter(p => p.startsWith('7|'))).toHaveLength(1)
  })

  it('"accept all" resolves every open suggestion, overlapping ones included', async () => {
    suggest(4, 9, 'slow')
    suggest(4, 15, 'dull')
    const r = await resolveSuggestions({ doc, reviewer, action: 'accept', select: {} })
    expect(r.resolved).toBe(2)
    expect(readSuggestions(h.doc)).toHaveLength(0)
  })

  it('rejects without touching the text', async () => {
    const s = suggest(4, 9, 'slow')
    const r = await resolveSuggestions({ doc, reviewer, action: 'reject', select: { ids: [s.id] } })
    expect(r).toEqual({ resolved: 1, missing: 0 })
    expect(text()).toBe('The quick brown fox jumps')
    expect(readSuggestions(h.doc)).toHaveLength(0)
    expect(h.principals.some(p => p.startsWith('7|'))).toBe(false)
    expect(h.activity[0]).toMatchObject({ action: 'suggestion.rejected', userId: 1, metadata: { count: 1, authors: ['Bea'], preview: 'quick → slow' } })
  })

  it('counts requested ids that no longer exist as missing and writes no activity when nothing resolved', async () => {
    const r = await resolveSuggestions({ doc, reviewer, action: 'accept', select: { ids: ['gone-0001'] } })
    expect(r).toEqual({ resolved: 0, missing: 1 })
    expect(h.activity).toHaveLength(0)
  })

  it('selects by author key only', async () => {
    suggest(0, 3, 'A', { authorId: 8, authorName: 'Cy' })
    suggest(4, 9, 'slow')
    const r = await resolveSuggestions({ doc, reviewer, action: 'reject', select: { authorKey: 'user:7' } })
    expect(r.resolved).toBe(1)
    expect(readSuggestions(h.doc).map(s => s.record.authorName)).toEqual(['Cy'])
  })

  it('closes the reply thread of a decided suggestion', async () => {
    const s = suggest(4, 9, 'slow')
    const comment = new Y.Map<unknown>()
    h.doc.getArray('comments').push([comment])
    comment.set('suggestionId', s.id)
    const other = new Y.Map<unknown>()
    h.doc.getArray('comments').push([other])
    other.set('suggestionId', 'someone-else')
    await resolveSuggestions({ doc, reviewer, action: 'reject', select: { ids: [s.id] } })
    expect(comment.get('resolved')).toBe(true)
    expect(other.get('resolved')).toBeUndefined()
  })

  it('still decides when the thread client cannot connect', async () => {
    const s = suggest(4, 9, 'slow')
    h.failThreadClient = true
    const r = await resolveSuggestions({ doc, reviewer, action: 'reject', select: { ids: [s.id] } })
    expect(r.resolved).toBe(1)
    expect(h.activity).toHaveLength(1)
  })

  it('records the reviewer, yjs boundaries and a preview for an accept', async () => {
    suggest(4, 9, '')
    await resolveSuggestions({ doc, reviewer, action: 'accept', select: {} })
    expect(h.activity[0]).toMatchObject({
      action: 'suggestion.accepted', userId: 1, userName: 'Rae', yjsDocIdBefore: 10, yjsDocIdAfter: 20,
      metadata: { kind: 'suggestion.accepted', count: 1, preview: 'quick' }
    })
    expect(h.flushed).toBeGreaterThanOrEqual(2)
  })

  it('refuses an accept spanning too many authors', async () => {
    for (let i = 1; i <= 21; i++) suggest(0, 0, 'x', { authorId: 100 + i, authorName: `U${i}` })
    await expect(resolveSuggestions({ doc, reviewer, action: 'accept', select: {} })).rejects.toThrow('suggestion/too-many-authors')
    expect(text()).toBe('The quick brown fox jumps')
  })

  it('truncates a long preview', async () => {
    suggest(4, 9, 'x'.repeat(100))
    await resolveSuggestions({ doc, reviewer, action: 'reject', select: {} })
    const preview = (h.activity[0]!.metadata as { preview: string }).preview
    expect(preview.endsWith('…')).toBe(true)
    expect(preview.length).toBeLessThan(80)
  })
})
