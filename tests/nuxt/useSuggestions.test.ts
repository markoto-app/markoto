import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import { anchorRange, readSuggestions, suggestionsMap } from '../../shared/utils/suggestions/ySuggestions'
import { parseSuggestion, type SuggestionRecord } from '../../shared/utils/suggestions/record'

const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn() }))
mockNuxtImport('apiFetch', () => apiFetchMock)

// eslint-disable-next-line import/first -- the mock must be registered before the composable loads
import { useSuggestions, SUGGEST_ORIGIN, AI_SUGGESTION_COLOR } from '~/composables/suggestions/useSuggestions'

function setup(text = 'The quick brown fox', user: Record<string, unknown> | null = { id: 1, name: 'Alice', color: '#112233' }) {
  const ydoc = new Y.Doc()
  ydoc.getText('content').insert(0, text)
  const awareness = new Awareness(ydoc)
  if (user) awareness.setLocalStateField('user', user)
  const api = useSuggestions(ydoc, awareness, 'doc-1')
  return { ydoc, awareness, api, ytext: ydoc.getText('content') }
}

function putRecord(ydoc: Y.Doc, over: Partial<SuggestionRecord>, from = 4, to = 9, text = 'slow'): SuggestionRecord {
  const ytext = ydoc.getText('content')
  const id = over.id ?? 'rec-000001'
  const r: SuggestionRecord = {
    v: 1, id, ...anchorRange(ytext, from, to), text, deleted: ytext.toString().slice(from, to),
    authorId: 9, authorName: 'Bob', authorAvatarSeed: null, authorPrincipal: null, color: '#AABBCC',
    createdAt: 1, updatedAt: 1, groupId: null, jobId: null, ...over
  }
  suggestionsMap(ydoc).set(id, r)
  return r
}

beforeEach(() => apiFetchMock.mockReset())

describe('useSuggestions', () => {
  it('derives kind, current text and marks from the map', () => {
    const { ydoc, api } = setup()
    putRecord(ydoc, { id: 'rec-ins001', text: '!' }, 3, 3)
    putRecord(ydoc, { id: 'rec-del001', text: '' }, 4, 9)
    putRecord(ydoc, { id: 'rec-rep001', text: 'x' }, 10, 15)
    const byId = Object.fromEntries(api.suggestions.value.map(s => [s.id, s]))
    expect(byId['rec-ins001']!.kind).toBe('insert')
    expect(byId['rec-del001']!.kind).toBe('delete')
    expect(byId['rec-rep001']!.kind).toBe('replace')
    expect(byId['rec-del001']!.current).toBe('quick')
    expect(api.marks.value).toHaveLength(3)
    expect(api.marks.value.find(m => m.id === 'rec-rep001')).toMatchObject({ from: 10, to: 15, text: 'x', authorName: 'Bob' })
  })

  it('keeps anchors on the right text while another author edits in front', () => {
    const { ydoc, api, ytext } = setup()
    putRecord(ydoc, { id: 'rec-000001' })
    ytext.insert(0, 'Well, ')
    const s = api.suggestions.value[0]!
    expect([s.from, s.to]).toEqual([10, 15])
    expect(s.current).toBe('quick')
    expect(s.changed).toBe(false)
  })

  it('flags a suggestion whose struck text changed and one whose text vanished', () => {
    const { ydoc, api, ytext } = setup()
    putRecord(ydoc, { id: 'rec-chg001', text: 'slow' }, 4, 9)
    putRecord(ydoc, { id: 'rec-obs001', text: '' }, 16, 19)
    ytext.insert(6, 'U')
    ytext.delete(17, 3)
    const by = Object.fromEntries(api.suggestions.value.map(s => [s.id, s]))
    expect(by['rec-chg001']!.changed).toBe(true)
    expect(by['rec-obs001']!.obsolete).toBe(true)
  })

  it('treats AI suggestions as such, with the AI colour and group key', () => {
    const { ydoc, api } = setup()
    putRecord(ydoc, { authorPrincipal: 'ai:assistant:s1', authorId: null, authorName: 'markoto', color: '#000000' })
    const s = api.suggestions.value[0]!
    expect(s.isAi).toBe(true)
    expect(s.color).toBe(AI_SUGGESTION_COLOR)
    expect(s.authorKey).toBe('ai')
    expect(s.mine).toBe(false)
  })

  it('marks own suggestions by user id and by anonymous avatar seed', () => {
    const a = setup()
    putRecord(a.ydoc, { id: 'rec-mine01', authorId: 1 })
    putRecord(a.ydoc, { id: 'rec-other1', authorId: 2 })
    expect(a.api.suggestions.value.filter(s => s.mine).map(s => s.id)).toEqual(['rec-mine01'])

    const b = setup('The quick brown fox', { name: 'Anon', avatarSeed: 'seed1' })
    putRecord(b.ydoc, { id: 'rec-anon01', authorId: null, authorAvatarSeed: 'seed1', authorName: 'Anon' })
    putRecord(b.ydoc, { id: 'rec-anon02', authorId: null, authorAvatarSeed: 'seed2', authorName: 'Anon' }, 10, 15)
    expect(b.api.suggestions.value.filter(s => s.mine).map(s => s.id)).toEqual(['rec-anon01'])
  })

  it('learns who "mine" is when awareness changes after the token arrives', () => {
    const { ydoc, awareness, api } = setup('The quick brown fox', null)
    putRecord(ydoc, { id: 'rec-mine01', authorId: 5 })
    expect(api.suggestions.value[0]!.mine).toBe(false)
    awareness.setLocalStateField('user', { id: 5, name: 'Eve' })
    expect(api.suggestions.value[0]!.mine).toBe(true)
  })

  describe('applyPlan', () => {
    it('creates a suggestion authored by the local user, anchored to the range, as an undoable origin', () => {
      const { ydoc, api } = setup()
      const origins: unknown[] = []
      ydoc.on('afterTransaction', (tr: Y.Transaction) => origins.push(tr.origin))
      api.applyPlan({ writes: [{ kind: 'create', from: 4, to: 9, text: 'slow' }], cursor: 8 })
      expect(origins).toContain(SUGGEST_ORIGIN)
      const [s] = readSuggestions(ydoc)
      expect(s!.record).toMatchObject({ text: 'slow', deleted: 'quick', authorId: 1, authorName: 'Alice', color: '#112233', authorPrincipal: null })
      expect([s!.from, s!.to]).toEqual([4, 9])
      expect(ydoc.getText('content').toString()).toBe('The quick brown fox')
    })

    it('falls back to Anonymous and the palette colour without awareness data', () => {
      const { ydoc, api } = setup('The quick brown fox', { color: 'not-a-colour', avatarSeed: 'abc123' })
      api.applyPlan({ writes: [{ kind: 'create', from: 0, to: 0, text: 'Hi ' }], cursor: 3 })
      const r = readSuggestions(ydoc)[0]!.record
      expect(r.authorName).toBe('Anonymous')
      expect(r.authorAvatarSeed).toBe('abc123')
      expect(r.color).toMatch(/^#[0-9a-fA-F]{6}$/)
    })

    it('updates a record in place and removes another, ignoring updates of unknown ids', () => {
      const { ydoc, api } = setup()
      putRecord(ydoc, { id: 'rec-upd001', authorId: 1 }, 4, 9, 'a')
      putRecord(ydoc, { id: 'rec-rem001', authorId: 1 }, 10, 15, 'b')
      api.applyPlan({
        writes: [
          { kind: 'update', id: 'rec-upd001', from: 4, to: 9, text: 'ab' },
          { kind: 'update', id: 'rec-nope01', from: 0, to: 1, text: 'z' },
          { kind: 'remove', id: 'rec-rem001' }
        ],
        cursor: 0
      })
      const all = readSuggestions(ydoc)
      expect(all.map(s => s.record.id)).toEqual(['rec-upd001'])
      expect(all[0]!.record.text).toBe('ab')
      expect(parseSuggestion(suggestionsMap(ydoc).get('rec-nope01'))).toBeNull()
    })

    it('does nothing for an empty plan', () => {
      const { ydoc, api } = setup()
      const spy = vi.fn()
      ydoc.on('update', spy)
      api.applyPlan({ writes: [], cursor: 0 })
      expect(spy).not.toHaveBeenCalled()
    })
  })

  describe('withdraw', () => {
    it('removes only your own suggestion', () => {
      const { ydoc, api } = setup()
      putRecord(ydoc, { id: 'rec-mine01', authorId: 1 })
      putRecord(ydoc, { id: 'rec-other1', authorId: 2 }, 10, 15)
      api.withdraw('rec-other1')
      expect(api.suggestions.value).toHaveLength(2)
      api.withdraw('rec-mine01')
      expect(api.suggestions.value.map(s => s.id)).toEqual(['rec-other1'])
      api.withdraw('rec-unknown')
      expect(api.suggestions.value).toHaveLength(1)
    })
  })

  describe('resolve', () => {
    it('posts the action with optional ids and author key', async () => {
      const { api } = setup()
      apiFetchMock.mockResolvedValue({ resolved: 2 })
      await expect(api.resolve('accept', { ids: ['a', 'b'] })).resolves.toEqual({ resolved: 2 })
      expect(apiFetchMock).toHaveBeenLastCalledWith('/api/docs/:docId/suggestions/resolve', { method: 'post', path: { docId: 'doc-1' }, body: { action: 'accept', ids: ['a', 'b'] } })
      await api.resolve('reject', { authorKey: 'ai' })
      expect(apiFetchMock).toHaveBeenLastCalledWith('/api/docs/:docId/suggestions/resolve', { method: 'post', path: { docId: 'doc-1' }, body: { action: 'reject', authorKey: 'ai' } })
      await api.resolve('accept')
      expect(apiFetchMock.mock.lastCall![1].body).toEqual({ action: 'accept' })
    })
  })
})
