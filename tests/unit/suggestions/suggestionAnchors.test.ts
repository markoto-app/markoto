import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import { anchorRange, applySuggestion, readSuggestions, suggestionsMap, textWithSuggestions } from '../../../shared/utils/suggestions/ySuggestions'
import { parseSuggestion, suggestionKind, type SuggestionRecord } from '../../../shared/utils/suggestions/record'

// Suggestions are anchored with Y.js relative positions, so they follow
// the text through concurrent edits. These cases play two peers against
// each other: one suggests, the other keeps editing.

function peer(text = ''): Y.Doc {
  const d = new Y.Doc()
  if (text) d.getText('content').insert(0, text)
  return d
}

/** Two docs that start in sync and exchange every later update. */
function pair(text: string): [Y.Doc, Y.Doc] {
  const a = peer(text)
  const b = new Y.Doc()
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a))
  a.on('update', (u: Uint8Array, origin: unknown) => {
    if (origin !== 'remote') Y.applyUpdate(b, u, 'remote')
  })
  b.on('update', (u: Uint8Array, origin: unknown) => {
    if (origin !== 'remote') Y.applyUpdate(a, u, 'remote')
  })
  return [a, b]
}

let n = 0
function suggest(doc: Y.Doc, from: number, to: number, text: string, over: Partial<SuggestionRecord> = {}): SuggestionRecord {
  const ytext = doc.getText('content')
  const id = `sugg-${String(++n).padStart(4, '0')}`
  const record: SuggestionRecord = {
    v: 1,
    id,
    ...anchorRange(ytext, from, to),
    text,
    deleted: ytext.toString().slice(from, to),
    authorId: 7,
    authorName: 'Bea',
    authorAvatarSeed: null,
    authorPrincipal: null,
    color: '#7A8C7E',
    createdAt: n,
    updatedAt: n,
    groupId: null,
    jobId: null,
    ...over
  }
  suggestionsMap(doc).set(id, record)
  return record
}

const rangeOf = (doc: Y.Doc, id: string) => {
  const s = readSuggestions(doc).find(x => x.record.id === id)
  return s ? { from: s.from, to: s.to, obsolete: s.obsolete, changed: s.changed } : null
}

describe('suggestion anchors', () => {
  it('a stored record parses, and its kind follows from range and text', () => {
    const d = peer('hello world')
    const r = suggest(d, 0, 5, 'howdy')
    expect(parseSuggestion(suggestionsMap(d).get(r.id))).toEqual(r)
    expect(suggestionKind(r)).toBe('replace')
    expect(suggestionKind({ text: 'x', deleted: '' })).toBe('insert')
    expect(suggestionKind({ text: '', deleted: 'x' })).toBe('delete')
  })

  it('follows its text when someone types in front of it', () => {
    const [a, b] = pair('the quick brown fox')
    const r = suggest(a, 4, 9, 'slow')
    b.getText('content').insert(0, 'See: ')
    expect(rangeOf(a, r.id)).toMatchObject({ from: 9, to: 14, changed: false })
    expect(rangeOf(b, r.id)).toMatchObject({ from: 9, to: 14 })
  })

  it('text typed right at either edge of the range stays outside it', () => {
    const [a, b] = pair('the quick brown fox')
    const r = suggest(a, 4, 9, '')
    b.getText('content').insert(9, '!')
    b.getText('content').insert(4, '>')
    expect(rangeOf(a, r.id)).toMatchObject({ from: 5, to: 10, changed: false })
  })

  it('an insertion follows the character after it', () => {
    const [a, b] = pair('ab')
    const r = suggest(a, 1, 1, 'X')
    b.getText('content').insert(0, '123')
    expect(rangeOf(a, r.id)).toMatchObject({ from: 4, to: 4 })
  })

  it('a struck range someone else deletes collapses and is marked obsolete', () => {
    const [a, b] = pair('keep this out')
    const r = suggest(a, 5, 10, '')
    b.getText('content').delete(4, 7)
    expect(rangeOf(a, r.id)).toMatchObject({ obsolete: true })
  })

  it('a replacement whose range someone else deleted still offers its text, as an insertion', () => {
    const [a, b] = pair('keep this out')
    const r = suggest(a, 5, 9, 'that')
    b.getText('content').delete(5, 4)
    const s = rangeOf(a, r.id)
    expect(s).toMatchObject({ from: 5, to: 5, obsolete: false, changed: true })
    a.transact(() => applySuggestion(a, r))
    expect(a.getText('content').toString()).toBe('keep that out')
  })

  it('a range someone else edited inside is flagged as changed and accepted as it is now', () => {
    const [a, b] = pair('the quick brown fox')
    const r = suggest(a, 4, 15, '')
    b.getText('content').insert(10, 'very ')
    expect(rangeOf(a, r.id)).toMatchObject({ from: 4, to: 20, changed: true })
    a.transact(() => applySuggestion(a, r))
    expect(a.getText('content').toString()).toBe('the  fox')
  })

  it('an insertion inside a range someone else deletes moves to where the range was', () => {
    const [a, b] = pair('one two three')
    const r = suggest(a, 6, 6, 'X')
    b.getText('content').delete(4, 4)
    expect(rangeOf(a, r.id)).toMatchObject({ from: 4, to: 4 })
  })

  it('accepting applies the change and removes the record; both peers converge', () => {
    const [a, b] = pair('colour of the sky')
    const r = suggest(a, 0, 6, 'color')
    b.transact(() => {
      const rec = parseSuggestion(suggestionsMap(b).get(r.id))
      if (rec) applySuggestion(b, rec)
    })
    expect(a.getText('content').toString()).toBe('color of the sky')
    expect(b.getText('content').toString()).toBe('color of the sky')
    expect(suggestionsMap(a).size).toBe(0)
  })

  it('overlapping suggestions of two authors: accepting one leaves the other on what remains', () => {
    const [a, b] = pair('alpha beta gamma')
    const first = suggest(a, 0, 10, '')
    const second = suggest(b, 6, 16, 'delta', { authorId: 8 })
    a.transact(() => applySuggestion(a, first))
    expect(a.getText('content').toString()).toBe(' gamma')
    expect(rangeOf(b, second.id)).toMatchObject({ from: 0, to: 6, changed: true })
    b.transact(() => {
      const rec = parseSuggestion(suggestionsMap(b).get(second.id))
      if (rec) applySuggestion(b, rec)
    })
    expect(b.getText('content').toString()).toBe('delta')
  })

  it('a rejected suggestion leaves the text untouched', () => {
    const d = peer('stay as is')
    const r = suggest(d, 0, 4, 'go')
    suggestionsMap(d).delete(r.id)
    expect(d.getText('content').toString()).toBe('stay as is')
  })

  it('undo of an accept restores the text and the suggestion', () => {
    const d = peer('teh cat')
    const um = new Y.UndoManager([d.getText('content'), suggestionsMap(d)], { trackedOrigins: new Set(['accept']) })
    const r = suggest(d, 0, 3, 'the')
    d.transact(() => applySuggestion(d, r), 'accept')
    expect(d.getText('content').toString()).toBe('the cat')
    um.undo()
    expect(d.getText('content').toString()).toBe('teh cat')
    expect(readSuggestions(d).map(s => s.record.id)).toEqual([r.id])
  })

  it('textWithSuggestions previews accepting everything, overlaps included', () => {
    const d = peer('alpha beta gamma')
    suggest(d, 0, 5, 'ALPHA')
    suggest(d, 11, 11, 'big ')
    suggest(d, 3, 10, '')
    // The strike of "ha beta" overlaps the replacement of "alpha": it is clipped to what is left.
    expect(textWithSuggestions(d.getText('content').toString(), readSuggestions(d))).toBe('ALPHA big gamma')
  })

  it('records that are not valid are ignored when reading', () => {
    const d = peer('text')
    suggestionsMap(d).set('broken', { v: 1, id: 'broken' })
    expect(readSuggestions(d)).toEqual([])
  })
})
