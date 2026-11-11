import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { FULL_AI_PROVIDERS } from './fixtures/aiProviders'
import * as Y from 'yjs'
import { LitellmBudgetExhausted } from '../../server/utils/litellm/userKeys'
import { soloSessionGuard } from './fixtures/crossBoundary'

// Phase 7: pin the runLoop's mid-loop budget-exhaustion catch path
// at the unit layer. Pre-Phase-6 the app-side `chargeInteractions`
// call threw `BudgetExhausted` BEFORE the model call; that catch
// path is gone. The new contract:
//
//   1. The first `streamFromProvider` call throws `LitellmBudgetExhausted`
//      (or any error matching `isBudgetExceededError`).
//   2. The runLoop catches it WITHOUT rethrowing.
//   3. A breadcrumb message is inserted into the session's Y.Doc with
//      a Markdown link to /pricing.
//   4. `setStatus('done', 'AI Points exhausted')` is called so the
//      client UI tears down the spinner.
//
// If a refactor ever drops the catch block (or drops the breadcrumb
// emission), this test fails uniformly.

const executeFunctionByName = vi.fn()
const webSearch = vi.fn()
const fetchUrl = vi.fn()

vi.mock('../../server/utils/ai/aiToolAdapter', () => ({ executeFunctionByName }))
vi.mock('../../server/utils/agentic/functionTools', async () => {
  const actual = await vi.importActual<typeof import('../../server/utils/agentic/functionTools')>(
    '../../server/utils/agentic/functionTools'
  )
  return { ...actual, webSearch, fetchUrl }
})
vi.mock('../../server/repos/activity', () => ({
  appendActivity: vi.fn().mockResolvedValue(undefined),
  pruneActivity: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('../../server/repos/documents', () => ({
  docExists: vi.fn().mockResolvedValue(false)
}))

const { runAgenticLoop } = await import('../../server/utils/agentic/runLoop')

function makeBudgetExhaustedAi() {
  return {
    models: {
      generateContentStream: async () => {
        throw new LitellmBudgetExhausted(42, 'budget_exceeded')
      }
    }
  } as unknown as Parameters<typeof runAgenticLoop>[0]['ai']
}

function makeAiThrowing(err: Error) {
  return {
    models: {
      generateContentStream: async () => { throw err }
    }
  } as unknown as Parameters<typeof runAgenticLoop>[0]['ai']
}

function makeAiSession() {
  // A real Y.Doc + Y.Text so we can assert the breadcrumb actually
  // landed in the document. Simulates how prompt.post.ts wires the
  // AI's Hocuspocus client — the catch path inserts via `ytext`.
  const ydoc = new Y.Doc()
  const ytext = ydoc.getText('content')
  return {
    ydoc,
    ytext,
    docId: 'doc-budget-test',
    initiatorUserId: 42,
    aiProviders: FULL_AI_PROVIDERS
  } as unknown as Parameters<typeof runAgenticLoop>[0]['aiSession']
}

function makeOpts(overrides: Partial<Parameters<typeof runAgenticLoop>[0]> = {}): Parameters<typeof runAgenticLoop>[0] {
  return {
    ai: overrides.ai ?? makeBudgetExhaustedAi(),
    model: 'mistral-test',
    systemPrompt: 'system',
    initialPrompt: 'doomed prompt',
    aiSession: overrides.aiSession ?? makeAiSession(),
    sessionId: 'sess-budget',
    abortController: new AbortController(),
    setStatus: vi.fn(),
    billingContext: {
      attributedTo: 'user:42',
      plan: 'pro',
      periodStart: new Date('2026-04-01T00:00:00.000Z'),
      periodEnd: new Date('2026-05-01T00:00:00.000Z'),
      virtualKey: 'sk-fake-test-virtual-key',
      attribution: 'user'
    },
    logger: () => {},
    crossBoundary: soloSessionGuard(),
    ...overrides
  }
}

beforeEach(() => {
  executeFunctionByName.mockReset()
  webSearch.mockReset()
  fetchUrl.mockReset()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('runLoop — LiteLLM budget-exceeded catch path', () => {
  it('does NOT rethrow when streamFromProvider throws LitellmBudgetExhausted', async () => {
    // The contract: the loop must return cleanly so the outer
    // try/finally in prompt.post can run cleanup. Throwing would
    // surface as a 500 to the user.
    await expect(runAgenticLoop(makeOpts())).resolves.toBeUndefined()
  })

  it('writes the upgrade-CTA breadcrumb into the Y.Doc when budget is exhausted (billing on)', async () => {
    vi.stubEnv('NUXT_BILLING_ENABLED', 'true')
    const aiSession = makeAiSession()
    await runAgenticLoop(makeOpts({ aiSession }))

    const ytext = (aiSession as unknown as { ytext: Y.Text }).ytext
    const docContent = ytext.toString()
    // The exact phrasing isn't load-bearing; assert structure: an
    // upgrade phrase + the /pricing link. Markdown formatting is
    // applied client-side by the preview pipeline.
    expect(docContent).toMatch(/AI Points exhausted/i)
    expect(docContent).toContain('/pricing')
    expect(docContent).toContain('pro') // billing context plan name
  })

  it('billing off (self-hosted): breadcrumb says the points refill and links nothing', async () => {
    vi.stubEnv('NUXT_BILLING_ENABLED', 'false')
    vi.stubEnv('NUXT_PLANS_COMING_SOON', 'false')
    const aiSession = makeAiSession()
    await runAgenticLoop(makeOpts({ aiSession }))

    const docContent = (aiSession as unknown as { ytext: Y.Text }).ytext.toString()
    expect(docContent).toMatch(/AI Points exhausted/i)
    expect(docContent).toMatch(/refill/i)
    expect(docContent).not.toContain('/pricing')
    expect(docContent).not.toMatch(/upgrade/i)
  })

  it('billing off + plans coming soon (hosted SaaS): breadcrumb mentions upcoming plans, never "upgrade"', async () => {
    vi.stubEnv('NUXT_BILLING_ENABLED', 'false')
    vi.stubEnv('NUXT_PLANS_COMING_SOON', 'true')
    const aiSession = makeAiSession()
    await runAgenticLoop(makeOpts({ aiSession }))

    const docContent = (aiSession as unknown as { ytext: Y.Text }).ytext.toString()
    expect(docContent).toMatch(/coming soon/i)
    expect(docContent).not.toMatch(/upgrade/i)
  })

  it('calls setStatus("done", "AI Points exhausted") so the UI tears down', async () => {
    const setStatus = vi.fn()
    await runAgenticLoop(makeOpts({ setStatus }))

    const exhaustedCall = setStatus.mock.calls.find(([phase]) => phase === 'done')
    expect(exhaustedCall).toBeDefined()
    expect(exhaustedCall![1]).toMatch(/AI Points exhausted/i)
  })

  it('also catches `isBudgetExceededError`-shape errors (raw fetch error from LiteLLM)', async () => {
    // The proxy returns `{ error: { message: "Budget has been exceeded ..." } }`.
    // The OpenAI SDK rethrows this as a regular Error whose message
    // contains "budget_exceeded" or "Budget has been exceeded". Our
    // predicate matches both — pin it here so a refactor that
    // tightens the regex doesn't silently drop coverage.
    const ai = makeAiThrowing(new Error('Request failed: budget_exceeded for key sk-***'))
    const aiSession = makeAiSession()
    await expect(runAgenticLoop(makeOpts({ ai, aiSession }))).resolves.toBeUndefined()
    const docContent = (aiSession as unknown as { ytext: Y.Text }).ytext.toString()
    expect(docContent).toMatch(/AI Points exhausted/i)
  })

  it('does NOT swallow unrelated upstream errors (regression guard)', async () => {
    // Generic errors (network blip, invalid request etc.) MUST still
    // surface — only `budget_exceeded`-shaped errors get the
    // breadcrumb-and-bail treatment.
    const ai = makeAiThrowing(new Error('upstream 500 Internal Server Error'))
    await expect(runAgenticLoop(makeOpts({ ai }))).rejects.toThrow(/upstream 500/i)
  })
})

// The shared monthly free-tier pool (LiteLLM team `markoto-free-tier`)
// is used up. The proxy's message names the TEAM, not the key — copied
// verbatim from LiteLLM v1.106.4. Handled differently from the per-user
// budget: no "AI Points" breadcrumb in the (possibly shared) document;
// the session ends with the typed "add your own key" message, which
// reaches the initiator only.
describe('runLoop — free-tier pool (team budget) exhausted', () => {
  const TEAM_EXHAUSTED = 'Error code: 422 - {"error":{"message":"Budget has been exceeded! Team=markoto-free-tier Current cost: 500.0012, Max budget: 500.0","type":"budget_exceeded","param":null,"code":"422"}}'

  it('ends the session with the free-allowance message and writes nothing into the document', async () => {
    const setStatus = vi.fn()
    const aiSession = makeAiSession()
    await expect(runAgenticLoop(makeOpts({ ai: makeAiThrowing(new Error(TEAM_EXHAUSTED)), aiSession, setStatus }))).resolves.toBeUndefined()

    const errorCall = setStatus.mock.calls.find(([phase]) => phase === 'error')
    expect(errorCall?.[1]).toBe('This month\'s free AI allowance is used up. Add your own key in Settings → AI provider to keep going.')
    expect(setStatus.mock.calls.some(([, message]) => /AI Points exhausted/i.test(String(message)))).toBe(false)
    expect((aiSession as unknown as { ytext: Y.Text }).ytext.toString()).toBe('')
  })

  it('a per-KEY exhaustion still takes the AI Points path', async () => {
    const setStatus = vi.fn()
    const keyExhausted = new Error('Budget has been exceeded! Key=key (sk-...lt2Q) Current cost: 0.51, Max budget: 0.5')
    await runAgenticLoop(makeOpts({ ai: makeAiThrowing(keyExhausted), setStatus }))
    expect(setStatus.mock.calls.find(([phase]) => phase === 'done')?.[1]).toMatch(/AI Points exhausted/i)
  })
})
