// @vitest-environment nuxt
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref, computed } from 'vue'
import { mountSuspended, registerEndpoint, mockNuxtImport } from '@nuxt/test-utils/runtime'
import { flushPromises } from '@vue/test-utils'
import { useQueryCache } from '@pinia/colada'
import { createError } from 'h3'
import { AIPromptBar } from '#components'
import type { AiAvailability } from '~~/shared/ai/providers'
import type { AiCredits } from '~/composables/ai/useAiCredits'
import type { BillingMode } from '~~/shared/config/billingMode'
import { aiKeys } from '~/queries/ai'
import { useAiCredits } from '~/composables/ai/useAiCredits'

// The AI Points budget is read from LiteLLM, which can still be starting
// when the editor opens. A failed read must not lock the prompt bar (the
// server enforces the budget on every prompt anyway), and the read is
// asked again until the budget arrives.

mockNuxtImport('useUserSession', () => () => ({
  loggedIn: ref(true),
  user: ref({ id: 1, name: 'Maya' }),
  session: ref({}),
  fetch: vi.fn(),
  clear: vi.fn()
}))
mockNuxtImport('useToast', () => () => ({ add: vi.fn() }))
registerEndpoint('/api/user/billing', () => new Promise(() => {}))

const credits: AiCredits = {
  pointsRemaining: 3000,
  pointsTotal: 5000,
  planPointsRemaining: 3000,
  creditPoints: 0,
  plan: 'free',
  periodEnd: '2027-02-01T00:00:00.000Z',
  resetsAt: null,
  attribution: 'user',
  freeAllowance: null,
  workspace: null
}

// Fails until `failuresLeft` runs out, like a proxy still booting.
let failuresLeft = 0
let calls = 0
registerEndpoint('/api/ai/credits', () => {
  calls++
  if (failuresLeft > 0) {
    failuresLeft--
    throw createError({ statusCode: 500, statusMessage: 'LiteLLM unavailable' })
  }
  return credits
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

beforeEach(() => {
  calls = 0
  failuresLeft = 0
  useState<BillingMode>('billing-mode').value = { billingEnabled: true, plansComingSoon: false }
  for (const ws of [null, 'ws-retry']) {
    useQueryCache().setQueryData<AiAvailability>(aiKeys.availabilityFor(ws), {
      chat: { available: true, source: 'instance', platformBilled: true, supportsVision: true },
      image: { available: false, source: 'none', platformBilled: false },
      transcription: { available: false, source: 'none', platformBilled: false, liveDictation: false },
      webTools: { search: true, fetch: true }
    })
  }
})

describe('AI Points read fails while LiteLLM starts', () => {
  it('the prompt bar stays usable while the budget is unknown', async () => {
    failuresLeft = 100
    const wrapper = await mountSuspended(AIPromptBar, { props: { ai: aiProps(), workspaceId: 'ws-retry' } })
    await flushPromises()
    const input = wrapper.get('[data-testid="ai-prompt-bar-input"]')
    expect(input.attributes('disabled')).toBeUndefined()
    expect(input.attributes('placeholder')).not.toContain('AI Points')
    wrapper.unmount()
  })

  it('asks again with backoff until the budget arrives', async () => {
    failuresLeft = 1
    const { state, isKnown } = await new Promise<ReturnType<typeof useAiCredits>>((resolve) => {
      void mountSuspended({
        setup() {
          resolve(useAiCredits(null))
          return () => null
        }
      })
    })
    await vi.waitFor(() => expect(isKnown.value).toBe(true), { timeout: 4000, interval: 50 })
    expect(calls).toBe(2)
    expect(state.value?.pointsRemaining).toBe(3000)
  })
})
