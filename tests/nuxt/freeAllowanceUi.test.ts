// @vitest-environment nuxt
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref, computed } from 'vue'
import { mountSuspended, registerEndpoint, mockNuxtImport } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { AIPromptBar, AuthUsageBadge, AuthUsageLimits } from '#components'
import type { UserBilling } from '~/composables/billing/useBilling'
import type { AiAvailability } from '~~/shared/ai/providers'
import type { AiCredits } from '~/composables/ai/useAiCredits'

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

const MB = 1024 * 1024
const BILLING: UserBilling = {
  plan: 'free',
  periodStart: new Date().toISOString(),
  periodEnd: new Date().toISOString(),
  ownedWorkspaces: 1,
  workspacesOwnedLimit: 1,
  knowledgeFilesUsed: 4,
  knowledgeFilesLimit: 5,
  knowledgeBytesUsed: 10 * MB,
  knowledgeBytesPerUserLimit: 50 * MB,
  imageBytesUsed: 20 * MB,
  imageBytesPerUserLimit: 100 * MB,
  credits: null,
  coveringWorkspaces: []
}
let billingHits = 0
registerEndpoint('/api/user/billing', () => {
  billingHits++
  return BILLING
})

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
  useState<Record<string, AiCredits | null>>('ai-credits').value = {
    '': {
      pointsRemaining: 300,
      pointsTotal: 500,
      plan: 'free',
      periodEnd: new Date().toISOString(),
      attribution: 'user',
      freeAllowance: { pooled: true, exhausted: poolExhausted, resetsAt: null },
      workspace: null
    }
  }
}

beforeEach(() => {
  useState<Record<string, AiCredits | null>>('ai-credits').value = {}
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
  it('only own keys → "Your own AI provider", opening the settings link + limits, no points meter', async () => {
    setAvailability('user')
    setCredits(false)
    useState<UserBilling | null>('billing').value = BILLING
    const wrapper = await mountSuspended(AuthUsageBadge, { attachTo: document.body })
    const chip = wrapper.find('[data-testid="usage-badge-own-provider"]')
    expect(chip.exists()).toBe(true)
    expect(chip.text()).toContain('Your own AI provider')
    expect(wrapper.find('[data-testid="usage-badge"]').exists()).toBe(false)

    const before = billingHits
    await chip.trigger('click')
    await flushPromises()
    const settings = document.body.querySelector('[data-testid="usage-badge-own-provider-settings"]')
    expect(settings?.getAttribute('href')).toBe('/settings/ai')
    expect(document.body.querySelector('[data-testid="usage-limits"]')).not.toBeNull()
    expect(document.body.querySelector('[data-testid="usage-limit-workspaces"]')?.textContent).toContain('1 / 1')
    // Opening the popover re-fetches the counts.
    expect(billingHits).toBeGreaterThan(before)
    wrapper.unmount()
  })

  it('platform-paid chat → the points meter, not the own-provider chip', async () => {
    setAvailability('instance')
    setCredits(false)
    useState<UserBilling | null>('billing').value = BILLING
    const wrapper = await mountSuspended(AuthUsageBadge, { attachTo: document.body })
    expect(wrapper.find('[data-testid="usage-badge-own-provider"]').exists()).toBe(false)
    // The points popover carries the storage & limits section below the meter.
    await wrapper.find('[data-testid="usage-badge"]').trigger('click')
    await flushPromises()
    expect(document.body.querySelector('[data-testid="usage-limit-images"]')?.textContent).toContain('20.0 MB / 100.0 MB')
    wrapper.unmount()
  })
})

describe('UsageLimits — storage & limits rows', () => {
  it('renders the four rows as used / limit, coloured by fill', async () => {
    const wrapper = await mountSuspended(AuthUsageLimits, { props: { billing: BILLING } })
    const rowOf = (key: string) => wrapper.find(`[data-testid="usage-limit-${key}"]`)
    expect(rowOf('images').text()).toContain('20.0 MB / 100.0 MB')
    expect(rowOf('images').attributes('data-level')).toBe('ok')
    expect(rowOf('knowledgeFiles').text()).toContain('4 / 5')
    expect(rowOf('knowledgeFiles').attributes('data-level')).toBe('warning')
    expect(rowOf('knowledgeStorage').text()).toContain('10.0 MB / 50.0 MB')
    expect(rowOf('workspaces').text()).toContain('1 / 1')
    expect(rowOf('workspaces').attributes('data-level')).toBe('critical')
    expect(rowOf('workspaces').find('[data-testid="usage-limit-bar"]').classes()).toContain('bg-red-500')
    expect(rowOf('workspaces').find('[data-testid="usage-limit-bar"]').attributes('style')).toContain('width: 100%')
  })

  it('a missing (unlimited) limit shows "unlimited" and an empty bar', async () => {
    // JSON turns an Infinity cap into null.
    const unlimited = JSON.parse(JSON.stringify({ ...BILLING, knowledgeFilesLimit: Infinity }))
    const wrapper = await mountSuspended(AuthUsageLimits, { props: { billing: unlimited } })
    const r = wrapper.find('[data-testid="usage-limit-knowledgeFiles"]')
    expect(r.attributes('data-unlimited')).toBe('true')
    expect(r.text()).toContain('4 / unlimited')
    expect(r.find('[data-testid="usage-limit-bar"]').attributes('style')).toContain('width: 0%')
  })
})
