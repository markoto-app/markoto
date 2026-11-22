// @vitest-environment nuxt
import { describe, it, expect } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { defineComponent, h } from 'vue'
import { TooltipProvider } from 'reka-ui'
import SuggestionCard from '~/components/suggestions/SuggestionCard.vue'
import type { DerivedSuggestion } from '~/composables/suggestions/useSuggestions'

/** Hand a deliberately partial object to a typed parameter. */
const unsafe = (v: unknown): never => v as never

// The margin card of one suggestion, or of a whole AI edit (grouped).

function suggestion(id: string, over: Partial<DerivedSuggestion> = {}): DerivedSuggestion {
  return {
    id,
    from: 0,
    to: 3,
    kind: 'replace',
    text: `new-${id}`,
    deleted: `old-${id}`,
    current: `old-${id}`,
    authorId: null,
    authorName: 'Maya',
    authorAvatarSeed: 'abc',
    authorKey: 'user:1',
    isAi: false,
    color: '#7A8C7E',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    obsolete: false,
    changed: false,
    mine: false,
    groupId: null,
    jobId: null,
    record: unsafe({}),
    ...over
  }
}

// UTooltip needs a Reka TooltipProvider ancestor (UApp provides it in the app).
async function mountCard(props: Record<string, unknown>) {
  const outer = await mountSuspended(defineComponent({
    render: () => h(TooltipProvider, null, { default: () => h(SuggestionCard, props as never) })
  }))
  return { root: outer, card: outer.findComponent(SuggestionCard) }
}

const base = { canReview: true, canReply: false, thread: null, focused: false, busy: false, viewerId: 1, viewerName: 'Maya' }

describe('SuggestionCard', () => {
  it('shows one suggestion and resolves just that one', async () => {
    const { root, card } = await mountCard({ ...base, suggestion: suggestion('a') })
    expect(root.findAll('[data-testid="suggestion-inserted-text"]')).toHaveLength(1)
    await root.find('[data-testid="suggestion-accept"]').trigger('click')
    await root.find('[data-testid="suggestion-reject"]').trigger('click')
    expect(card.emitted('accept')?.[0]).toEqual([['a']])
    expect(card.emitted('reject')?.[0]).toEqual([['a']])
  })

  it('shows every change of a grouped AI edit on one card and resolves them together', async () => {
    const a = suggestion('a', { isAi: true, groupId: 'g', authorKey: 'ai', authorName: 'markoto' })
    const b = suggestion('b', { isAi: true, groupId: 'g', authorKey: 'ai' })
    const c = suggestion('c', { isAi: true, groupId: 'g', authorKey: 'ai', kind: 'delete', text: '' })
    const { root, card } = await mountCard({ ...base, suggestion: a, members: [a, b, c] })
    expect(root.findAll('[data-testid="suggestion-deleted-text"]')).toHaveLength(3)
    expect(root.findAll('[data-testid="suggestion-inserted-text"]')).toHaveLength(2)
    expect(root.find('[data-testid="suggestion-inserted-text"]').classes()).toContain('suggest-card-ai')
    await root.find('[data-testid="suggestion-accept"]').trigger('click')
    expect(card.emitted('accept')?.[0]).toEqual([['a', 'b', 'c']])
  })

  it('keeps the relative time as the locale writes it (no forced lower case)', async () => {
    const { root } = await mountCard({ ...base, suggestion: suggestion('a') })
    const time = root.find('span[title]')
    expect(time.exists()).toBe(true)
    expect(time.classes()).not.toContain('lowercase')
  })

  it('lets the author withdraw when review is not allowed', async () => {
    const { root, card } = await mountCard({ ...base, canReview: false, suggestion: suggestion('a', { mine: true }) })
    await root.find('[data-testid="suggestion-withdraw"]').trigger('click')
    expect(card.emitted('withdraw')?.[0]).toEqual(['a'])
  })
})
