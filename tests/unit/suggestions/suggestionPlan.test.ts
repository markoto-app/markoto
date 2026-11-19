import { describe, it, expect } from 'vitest'
import { planSuggestion, type OwnSuggestion } from '../../../shared/utils/suggestions/plan'

// Keystrokes in suggesting mode become suggestion writes. Typing continues
// the author's own suggestion; everything else opens a new one.

const own = (id: string, from: number, to: number, text: string): OwnSuggestion => ({ id, from, to, text })

describe('planSuggestion: typing', () => {
  it('opens an insertion where nothing of mine is', () => {
    const plan = planSuggestion([{ from: 4, to: 4, insert: 'a' }], [], false)
    expect(plan.writes).toEqual([{ kind: 'create', from: 4, to: 4, text: 'a' }])
    expect(plan.cursor).toBe(4)
  })

  it('appends to my insertion at the caret instead of opening another', () => {
    const plan = planSuggestion([{ from: 4, to: 4, insert: 'b' }], [own('s1', 4, 4, 'a')], false)
    expect(plan.writes).toEqual([{ kind: 'update', id: 's1', from: 4, to: 4, text: 'ab' }])
  })

  it('appends to a replacement whose text ends at the caret', () => {
    const plan = planSuggestion([{ from: 9, to: 9, insert: 'y' }], [own('s1', 4, 9, 'x')], false)
    expect(plan.writes).toEqual([{ kind: 'update', id: 's1', from: 4, to: 9, text: 'xy' }])
    expect(plan.cursor).toBe(9)
  })

  it('turns my strike into a replacement when I type at its start', () => {
    const plan = planSuggestion([{ from: 4, to: 4, insert: 'z' }], [own('s1', 4, 9, '')], false)
    expect(plan.writes).toEqual([{ kind: 'update', id: 's1', from: 4, to: 9, text: 'z' }])
    expect(plan.cursor).toBe(9)
  })

  it('typing over a selection proposes replacing exactly that range', () => {
    const plan = planSuggestion([{ from: 2, to: 6, insert: 'new' }], [], false)
    expect(plan.writes).toEqual([{ kind: 'create', from: 2, to: 6, text: 'new' }])
    expect(plan.cursor).toBe(6)
  })

  it('a pending suggestion created earlier in the same transaction is continued, not duplicated', () => {
    const plan = planSuggestion([{ from: 3, to: 3, insert: 'a' }, { from: 3, to: 3, insert: 'b' }], [], false)
    expect(plan.writes).toEqual([{ kind: 'create', from: 3, to: 3, text: 'ab' }])
  })
})

describe('planSuggestion: deleting', () => {
  it('Backspace right after my inserted text takes from that text', () => {
    const plan = planSuggestion([{ from: 3, to: 4, insert: '' }], [own('s1', 4, 4, 'abc')], true)
    expect(plan.writes).toEqual([{ kind: 'update', id: 's1', from: 4, to: 4, text: 'ab' }])
    expect(plan.cursor).toBe(4)
  })

  it('Backspace over my last inserted character removes the suggestion', () => {
    const plan = planSuggestion([{ from: 3, to: 4, insert: '' }], [own('s1', 4, 4, 'a')], true)
    expect(plan.writes).toEqual([{ kind: 'remove', id: 's1' }])
  })

  it('Backspace removes one whole character, an emoji included', () => {
    const plan = planSuggestion([{ from: 3, to: 4, insert: '' }], [own('s1', 4, 4, 'ok😀')], true)
    expect(plan.writes).toEqual([{ kind: 'update', id: 's1', from: 4, to: 4, text: 'ok' }])
  })

  it('strikes text nobody suggested on and moves the caret left on Backspace', () => {
    const plan = planSuggestion([{ from: 5, to: 6, insert: '' }], [], true)
    expect(plan.writes).toEqual([{ kind: 'create', from: 5, to: 6, text: '' }])
    expect(plan.cursor).toBe(5)
  })

  it('Delete (forward) keeps the caret after the struck character', () => {
    const plan = planSuggestion([{ from: 5, to: 6, insert: '' }], [], false)
    expect(plan.cursor).toBe(6)
  })

  it('extends my strike when I keep deleting next to it', () => {
    const left = planSuggestion([{ from: 4, to: 5, insert: '' }], [own('s1', 5, 8, '')], true)
    expect(left.writes).toEqual([{ kind: 'update', id: 's1', from: 4, to: 8, text: '' }])
    const right = planSuggestion([{ from: 8, to: 9, insert: '' }], [own('s1', 5, 8, '')], false)
    expect(right.writes).toEqual([{ kind: 'update', id: 's1', from: 5, to: 9, text: '' }])
  })

  it('joins two of my strikes that a deletion bridges', () => {
    const plan = planSuggestion([{ from: 3, to: 6, insert: '' }], [own('a', 0, 3, ''), own('b', 6, 9, '')], false)
    expect(plan.writes).toEqual(expect.arrayContaining([
      { kind: 'update', id: 'a', from: 0, to: 9, text: '' },
      { kind: 'remove', id: 'b' }
    ]))
    expect(plan.writes).toHaveLength(2)
  })

  it('grows a replacement at its start, its text stays at the end', () => {
    const plan = planSuggestion([{ from: 3, to: 4, insert: '' }], [own('s1', 4, 9, 'new')], true)
    expect(plan.writes).toEqual([{ kind: 'update', id: 's1', from: 3, to: 9, text: 'new' }])
    expect(plan.cursor).toBe(3)
  })

  it('deleting inside my own strike only moves the caret', () => {
    const plan = planSuggestion([{ from: 6, to: 7, insert: '' }], [own('s1', 4, 9, '')], true)
    expect(plan.writes).toEqual([])
    expect(plan.cursor).toBe(6)
  })

  it('never merges into a suggestion of someone else (it is not in `own`)', () => {
    const plan = planSuggestion([{ from: 4, to: 4, insert: 'x' }], [], false)
    expect(plan.writes[0]?.kind).toBe('create')
  })
})
