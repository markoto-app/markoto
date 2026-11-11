// @vitest-environment nuxt
import { describe, it, expect, vi } from 'vitest'
import { ref, computed } from 'vue'
import { mountSuspended, registerEndpoint, mockNuxtImport } from '@nuxt/test-utils/runtime'
import { AIPromptBar } from '#components'
import type { AiAvailability } from '~~/shared/ai/providers'

// Bring your own key: the prompt bar must turn into an "Add your
// API key in Settings" call-to-action when the user has no chat
// provider (no own key, no instance default), and hide the voice mic
// when there is no transcription provider. Availability is the
// `useState('ai-availability')` snapshot `useAiAvailability()` reads;
// tests set it directly, like the client fetch would.

mockNuxtImport('useUserSession', () => () => ({
  loggedIn: ref(true),
  user: ref({ id: 1, name: 'Maya' }),
  session: ref({}),
  fetch: vi.fn(),
  clear: vi.fn()
}))
const { toastAdd } = vi.hoisted(() => ({ toastAdd: vi.fn() }))
mockNuxtImport('useToast', () => () => ({ add: toastAdd }))

registerEndpoint('/api/ai/credits', () => ({ pointsRemaining: 0, pointsTotal: 1000, plan: 'free', periodEnd: new Date().toISOString(), attribution: 'user' }))
registerEndpoint('/api/user/billing', () => ({ plan: 'free' }))

type AiProp = InstanceType<typeof AIPromptBar>['$props']['ai']

function aiProps(): AiProp {
  return {
    mySession: computed(() => null),
    mySessionId: computed(() => null),
    otherSessions: computed(() => []),
    submitting: ref(false),
    lastError: ref<string | null>(null),
    budgetExhausted: ref(false),
    lastResponse: ref<AiProp['lastResponse']['value']>(null),
    pendingConfirmation: computed(() => null),
    answeringConfirmation: ref(false),
    answerConfirmation: async () => {},
    prompt: async () => true,
    abort: async () => {},
    clearLastError: () => {}
  }
}

function status(available: boolean, source: 'user' | 'instance' | 'none', platformBilled = false) {
  return { available, source, platformBilled }
}

function setAvailability(a: Omit<AiAvailability, 'webTools'>): void {
  useState<AiAvailability | null>('ai-availability').value = { ...a, webTools: { search: true, fetch: true } }
}

describe('AIPromptBar — bring your own key', () => {
  it('no chat provider → settings call-to-action instead of the input, no mic', async () => {
    setAvailability({
      chat: { ...status(false, 'none'), supportsVision: false },
      image: status(false, 'none'),
      transcription: { ...status(false, 'none'), liveDictation: false }
    })
    const wrapper = await mountSuspended(AIPromptBar, { props: { ai: aiProps() } })
    const cta = wrapper.find('[data-testid="ai-prompt-bar-provider-cta"]')
    expect(cta.exists()).toBe(true)
    expect(cta.attributes('href')).toBe('/settings/ai')
    expect(wrapper.find('[data-testid="ai-prompt-bar-input"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="ai-prompt-bar-settings"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="ai-prompt-bar-mic"]').exists()).toBe(false)
  })

  it('own chat key, no transcription → input shown, mic hidden, an empty points budget does not block', async () => {
    setAvailability({
      chat: { ...status(true, 'user'), supportsVision: true },
      image: status(false, 'none'),
      transcription: { ...status(false, 'none'), liveDictation: false }
    })
    const wrapper = await mountSuspended(AIPromptBar, { props: { ai: aiProps() } })
    const input = wrapper.find('[data-testid="ai-prompt-bar-input"]')
    expect(input.exists()).toBe(true)
    // The stubbed credits report 0 points left, but chat runs on the
    // user's own key, so the bar stays enabled.
    expect(input.attributes('disabled')).toBeUndefined()
    expect(wrapper.find('[data-testid="ai-prompt-bar-provider-cta"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="ai-prompt-bar-mic"]').exists()).toBe(false)
  })

  it('everything available → input and mic', async () => {
    setAvailability({
      chat: { ...status(true, 'instance', true), supportsVision: true },
      image: status(true, 'instance', true),
      transcription: { ...status(true, 'instance', true), liveDictation: true }
    })
    const wrapper = await mountSuspended(AIPromptBar, { props: { ai: aiProps() } })
    expect(wrapper.find('[data-testid="ai-prompt-bar-input"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="ai-prompt-bar-mic"]').exists()).toBe(true)
  })
})

describe('AIPromptBar — AI by plan', () => {
  it('voice the plan doesn\'t include → a locked mic that explains, not a hidden one', async () => {
    toastAdd.mockClear()
    setAvailability({
      chat: { ...status(true, 'instance', true), supportsVision: true },
      image: { ...status(false, 'none'), locked: 'plan' },
      transcription: { ...status(false, 'none'), liveDictation: false, locked: 'plan' }
    })
    const wrapper = await mountSuspended(AIPromptBar, { props: { ai: aiProps() } })
    expect(wrapper.find('[data-testid="ai-prompt-bar-mic"]').exists()).toBe(false)
    const locked = wrapper.find('[data-testid="ai-prompt-bar-mic-locked"]')
    expect(locked.exists()).toBe(true)
    await locked.trigger('click')
    expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({ title: 'Voice input isn\'t included in this plan' }))
    const call = toastAdd.mock.calls.at(-1)![0] as { actions: Array<{ label: string }> }
    expect(call.actions.map(a => a.label)).toContain('Add your own key')
  })
})
