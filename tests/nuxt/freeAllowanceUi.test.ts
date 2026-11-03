// @vitest-environment nuxt
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref, computed } from 'vue'
import { mountSuspended, registerEndpoint, mockNuxtImport } from '@nuxt/test-utils/runtime'
import { AIPromptBar, AuthUsageBadge } from '#components'
import type { AiAvailability } from '~~/shared/ai/providers'
import type { AiCredits } from '~/composables/useAiCredits'

// Free AI allowance (hosted): when the shared monthly free-tier pool is
// used up, the prompt bar must block platform-paid chat with the "add
// your own key" message — even while the user's own points aren't spent —
// and must NOT block a user on their own key. The top bar shows "Your own
// AI provider" instead of points when nothing is platform-paid.

mockNuxtImport('useUserSession', () => () => ({
  loggedIn: ref(true),
  user: ref({ id: 1, name: 'Maya' }),
  session: ref({}),
  fetch: vi.fn(),
  clear: vi.fn()
}))
mockNuxtImport('useToast', () => () => ({ add: vi.fn() }))

registerEndpoint('/api/user/billing', () => ({ plan: 'free', periodEnd: new Date().toISOString() }))

type AiProp = InstanceType<typeof AIPromptBar>['$props']['ai']

function aiProps(): AiProp {
  return {
    mySession: computed(() => null),
    mySessionId: computed(() => null),
    otherSessions: computed(() => []),
    submitting: ref(false),
    lastError: ref<string | null>(null),
    budgetExhausted: ref(false),
    freeAllowanceExhausted: ref(false),
    lastResponse: ref<AiProp['lastResponse']['value']>(null),
    pendingConfirmation: computed(() => null),
    answeringConfirmation: ref(false),
    answerConfirmation: async () => {},
    prompt: async () => true,
    abort: async () => {},
    clearLastError: () => {}
  }
}

function setAvailability(chatSource: 'user' | 'instance'): void {
  const platformBilled = chatSource === 'instance'
  useState<AiAvailability | null>('ai-availability').value = {
    chat: { available: true, source: chatSource, platformBilled, supportsVision: true },
    image: { available: false, source: 'none', platformBilled: false },
    transcription: { available: false, source: 'none', platformBilled: false, liveDictation: false },
    webTools: { search: true, fetch: true }
  }
}

function setCredits(poolExhausted: boolean): void {
  useState<AiCredits | null>('ai-credits').value = {
    pointsRemaining: 300,
    pointsTotal: 500,
    plan: 'free',
    periodEnd: new Date().toISOString(),
    attribution: 'user',
    freeAllowance: { pooled: true, exhausted: poolExhausted, resetsAt: null }
  }
}

beforeEach(() => {
  useState<AiCredits | null>('ai-credits').value = null
})

describe('AIPromptBar — free AI allowance', () => {
  it('pool used up + platform-paid chat → input blocked with the "add your own key" placeholder', async () => {
    setAvailability('instance')
    setCredits(true)
    const wrapper = await mountSuspended(AIPromptBar, { props: { ai: aiProps() } })
    const input = wrapper.find('[data-testid="ai-prompt-bar-input"]')
    expect(input.attributes('disabled')).toBeDefined()
    expect(input.attributes('placeholder')).toBe('This month\'s free AI allowance is used up — add your own key to keep going')
  })

  it('pool used up but the user is on their own key → nothing is blocked', async () => {
    setAvailability('user')
    setCredits(true)
    const wrapper = await mountSuspended(AIPromptBar, { props: { ai: aiProps() } })
    const input = wrapper.find('[data-testid="ai-prompt-bar-input"]')
    expect(input.attributes('disabled')).toBeUndefined()
  })

  it('pool available + points left → normal prompt bar', async () => {
    setAvailability('instance')
    setCredits(false)
    const wrapper = await mountSuspended(AIPromptBar, { props: { ai: aiProps() } })
    const input = wrapper.find('[data-testid="ai-prompt-bar-input"]')
    expect(input.attributes('disabled')).toBeUndefined()
    expect(input.attributes('placeholder')).not.toContain('free AI allowance')
  })
})

describe('UsageBadge — whose AI it is', () => {
  it('only own keys → "Your own AI provider", linking the settings, no points meter', async () => {
    setAvailability('user')
    setCredits(false)
    const wrapper = await mountSuspended(AuthUsageBadge)
    const chip = wrapper.find('[data-testid="usage-badge-own-provider"]')
    expect(chip.exists()).toBe(true)
    expect(chip.text()).toContain('Your own AI provider')
    expect(chip.attributes('href')).toBe('/settings/ai')
    expect(wrapper.find('[data-testid="usage-badge"]').exists()).toBe(false)
  })

  it('platform-paid chat → the points meter, not the own-provider chip', async () => {
    setAvailability('instance')
    setCredits(false)
    const wrapper = await mountSuspended(AuthUsageBadge)
    expect(wrapper.find('[data-testid="usage-badge-own-provider"]').exists()).toBe(false)
  })
})
