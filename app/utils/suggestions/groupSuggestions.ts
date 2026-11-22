import type { DerivedSuggestion } from '~/composables/suggestions/useSuggestions'

/** One margin card: the suggestions of one AI edit (shared `groupId`), or a single suggestion. */
export interface SuggestionCardGroup {
  /** The first member (document order): names the card and receives focus. */
  primary: DerivedSuggestion
  members: DerivedSuggestion[]
}

/**
 * Cards for a list of suggestions in document order. Suggestions with the
 * same `groupId` from the same author are one card, placed where the
 * group's first member is. People's suggestions never carry a group.
 */
export function groupSuggestions(list: readonly DerivedSuggestion[]): SuggestionCardGroup[] {
  const cards: SuggestionCardGroup[] = []
  const byGroup = new Map<string, SuggestionCardGroup>()
  for (const s of list) {
    if (s.groupId === null) {
      cards.push({ primary: s, members: [s] })
      continue
    }
    const key = `${s.authorKey}\u0000${s.groupId}`
    const existing = byGroup.get(key)
    if (existing) {
      existing.members.push(s)
      continue
    }
    const card = { primary: s, members: [s] }
    byGroup.set(key, card)
    cards.push(card)
  }
  return cards
}

/** The card a suggestion belongs to, by any member id. */
export function cardIdOf(cards: readonly SuggestionCardGroup[], id: string): string {
  return cards.find(c => c.members.some(m => m.id === id))?.primary.id ?? id
}
