import { describe, it, expect } from 'vitest'
import { cardIdOf, groupSuggestions } from '../../../app/utils/suggestions/groupSuggestions'
import type { DerivedSuggestion } from '../../../app/composables/suggestions/useSuggestions'

/** Hand a deliberately partial object to a typed parameter. */
const unsafe = (v: unknown): never => v as never

function s(id: string, over: Partial<DerivedSuggestion> = {}): DerivedSuggestion {
  return unsafe({ id, authorKey: 'ai', groupId: null, ...over })
}

describe('groupSuggestions', () => {
  it('keeps ungrouped suggestions as single cards in order', () => {
    const cards = groupSuggestions([s('a', { authorKey: 'user:1' }), s('b', { authorKey: 'user:1' })])
    expect(cards.map(c => c.primary.id)).toEqual(['a', 'b'])
    expect(cards.every(c => c.members.length === 1)).toBe(true)
  })

  it('puts the suggestions of one AI edit on one card, where its first member is', () => {
    const cards = groupSuggestions([s('a', { groupId: 'g1' }), s('p', { authorKey: 'user:1' }), s('b', { groupId: 'g1' }), s('c', { groupId: 'g2' }), s('d', { groupId: 'g1' })])
    expect(cards.map(c => c.primary.id)).toEqual(['a', 'p', 'c'])
    expect(cards[0]!.members.map(m => m.id)).toEqual(['a', 'b', 'd'])
  })

  it('does not merge equal group ids of different authors', () => {
    const cards = groupSuggestions([s('a', { groupId: 'g', authorKey: 'ai' }), s('b', { groupId: 'g', authorKey: 'user:2' })])
    expect(cards).toHaveLength(2)
  })

  it('finds the card of any member', () => {
    const cards = groupSuggestions([s('a', { groupId: 'g1' }), s('b', { groupId: 'g1' })])
    expect(cardIdOf(cards, 'b')).toBe('a')
    expect(cardIdOf(cards, 'zzz')).toBe('zzz')
  })
})
