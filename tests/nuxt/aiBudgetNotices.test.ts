// @vitest-environment nuxt
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref, computed } from 'vue'
import { mountSuspended, registerEndpoint, mockNuxtImport } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { useQueryCache } from '@pinia/colada'
import { AIPromptBar } from '#components'
import type { AiAvailability } from '~~/shared/ai/providers'
import type { AiCredits } from '~/composables/ai/useAiCredits'
import type { BillingMode } from '~~/shared/config/billingMode'
import { aiKeys } from '~/queries/ai'

// The out-of-AI-Points notices in the prompt bar. A document's workspace
// resolves after the page, so the budget the bar reads switches from the
// user's own to the workspace's: that switch, and a budget still loading,
// must never raise "out of AI Points". When a budget does run out, the
// notice names whose it is and the way forward: buying AI Points on Pro,
// the workspace's billing for its admins, an admin for its members.

mockNuxtImport('useUserSession', () => () => ({
  loggedIn: ref(true),
  user: ref({ id: 1, name: 'Maya' }),
  session: ref({}),
  fetch: vi.fn(),
  clear: vi.fn()
}))
const toastAdd = vi.fn()
mockNuxtImport('useToast', () => () => ({ add: toastAdd }))
// A budget that hasn't been put in the cache stays loading.
registerEndpoint('/api/ai/credits', () => new Promise(() => {}))
registerEndpoint('/api/user/billing', () => new Promise(() => {}))

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

function personal(plan: 'free' | 'pro', left: number): AiCredits {
  return {
    pointsRemaining: left,
    pointsTotal: 5000,
    planPointsRemaining: left,
    creditPoints: 0,
    plan,
    periodEnd: '2027-02-01T00:00:00.000Z',
    resetsAt: null,
    attribution: 'user',
    freeAllowance: null,
    workspace: null
  }
}

function pooled(workspaceId: string, opts: { left: number, canManage: boolean }): AiCredits {
  return {
    pointsRemaining: opts.left,
    pointsTotal: 10000,
    planPointsRemaining: opts.left,
    creditPoints: 0,
    plan: 'business',
    periodEnd: '2027-02-01T00:00:00.000Z',
    resetsAt: null,
    attribution: 'workspace',
    freeAllowance: null,
    workspace: {
      workspaceId,
      canManage: opts.canManage,
      teamBudgetUsd: 17.85,
      teamSpendUsd: opts.left > 0 ? 0.007 : 17.85,
      memberLimitUsd: 10,
      memberSpendUsd: 0,
      exhausted: opts.left <= 0,
      teamExhausted: opts.left <= 0
    }
  }
}

function setCredits(workspaceId: string | null, credits: AiCredits): void {
  useQueryCache().setQueryData<AiCredits>(aiKeys.creditsFor(workspaceId), credits)
}

beforeEach(() => {
  toastAdd.mockReset()
  useState<BillingMode>('billing-mode').value = { billingEnabled: true, plansComingSoon: false }
  useQueryCache().setQueryData<AiAvailability>(aiKeys.availabilityFor(null), {
    chat: { available: true, source: 'instance', platformBilled: true, supportsVision: true },
    image: { available: false, source: 'none', platformBilled: false },
    transcription: { available: false, source: 'none', platformBilled: false, liveDictation: false },
    webTools: { search: true, fetch: true }
  })
})

const placeholder = (wrapper: Awaited<ReturnType<typeof mountSuspended>>) =>
  wrapper.get('[data-testid="ai-prompt-bar-input"]').attributes('placeholder')

describe('AI Points notices: opening a workspace document', () => {
  it('no "out of AI Points" while the budget switches to the workspace\'s and loads', async () => {
    setCredits(null, personal('free', 3000))
    const wrapper = await mountSuspended(AIPromptBar, { props: { ai: aiProps(), workspaceId: null } })
    await flushPromises()
    // The document's workspace resolves: its budget isn't loaded yet.
    await wrapper.setProps({ workspaceId: 'ws-open' })
    await flushPromises()
    expect(toastAdd).not.toHaveBeenCalled()
    expect(wrapper.get('[data-testid="ai-prompt-bar-input"]').attributes('disabled')).toBeUndefined()
    // It arrives with points left.
    setCredits('ws-open', pooled('ws-open', { left: 9993, canManage: false }))
    await flushPromises()
    expect(toastAdd).not.toHaveBeenCalled()
    expect(placeholder(wrapper)).not.toContain('AI Points')
  })

  it('a budget already empty when first read shows the placeholder, no toast', async () => {
    setCredits('ws-empty', pooled('ws-empty', { left: 0, canManage: false }))
    const wrapper = await mountSuspended(AIPromptBar, { props: { ai: aiProps(), workspaceId: 'ws-empty' } })
    await flushPromises()
    expect(toastAdd).not.toHaveBeenCalled()
    expect(placeholder(wrapper)).toBe('Workspace AI Points used up: ask an admin')
  })
})

describe('AI Points notices: the budget runs out while writing', () => {
  it('workspace member: names the workspace and points to an admin, no upgrade', async () => {
    setCredits('ws-member', pooled('ws-member', { left: 500, canManage: false }))
    const wrapper = await mountSuspended(AIPromptBar, { props: { ai: aiProps(), workspaceId: 'ws-member' } })
    await flushPromises()
    setCredits('ws-member', pooled('ws-member', { left: 0, canManage: false }))
    await flushPromises()
    expect(toastAdd).toHaveBeenCalledTimes(1)
    expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Workspace AI Points used up',
      description: 'This workspace’s AI Points for this month are used up. Ask a workspace admin for more.',
      actions: undefined
    }))
    expect(placeholder(wrapper)).toBe('Workspace AI Points used up: ask an admin')
  })

  it('workspace admin: seats or AI Points under Billing, with a link there', async () => {
    setCredits('ws-admin', pooled('ws-admin', { left: 500, canManage: true }))
    const wrapper = await mountSuspended(AIPromptBar, { props: { ai: aiProps(), workspaceId: 'ws-admin' } })
    await flushPromises()
    setCredits('ws-admin', pooled('ws-admin', { left: 0, canManage: true }))
    await flushPromises()
    const toast = toastAdd.mock.calls[0]?.[0]
    expect(toast.description).toBe('This workspace’s AI Points for this month are used up. Add seats or buy AI Points under Billing.')
    expect(toast.actions.map((a: { label: string }) => a.label)).toEqual(['Open billing'])
    expect(placeholder(wrapper)).toBe('Workspace AI Points used up: add more under Billing')
  })

  it('Pro (the top personal plan): buy AI Points, not upgrade', async () => {
    setCredits(null, personal('pro', 200))
    const wrapper = await mountSuspended(AIPromptBar, { props: { ai: aiProps(), workspaceId: null } })
    await flushPromises()
    setCredits(null, personal('pro', 0))
    await flushPromises()
    const toast = toastAdd.mock.calls[0]?.[0]
    expect(toast.title).toBe('Out of AI Points')
    expect(toast.actions.map((a: { label: string }) => a.label)).toEqual(['Buy AI Points'])
    expect(placeholder(wrapper)).toBe('Out of AI Points: buy more to continue')
  })

  it('Free: upgrade', async () => {
    setCredits(null, personal('free', 200))
    await mountSuspended(AIPromptBar, { props: { ai: aiProps(), workspaceId: null } })
    await flushPromises()
    setCredits(null, personal('free', 0))
    await flushPromises()
    const toast = toastAdd.mock.calls[0]?.[0]
    expect(toast.description).toBe('Your AI Points for this period are used up. Upgrade your plan to keep going.')
    expect(toast.actions.map((a: { label: string }) => a.label)).toEqual(['Upgrade'])
  })
})
