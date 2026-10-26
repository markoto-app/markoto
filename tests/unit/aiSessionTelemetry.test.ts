import { describe, it, expect, vi, beforeEach } from 'vitest'
import { FULL_AI_PROVIDERS } from './fixtures/aiProviders'
import {
  AgenticFinishReason as FinishReason,
  type AgenticGenerateContentResponse as GenerateContentResponse,
  type AgenticFunctionCall as FunctionCall
} from '../../server/utils/agentic/aiTypes'

// Tests for Item 1 — AI session telemetry. The runLoop must emit a
// single `Sentry.captureMessage('ai-session-completed', ...)` on every
// exit path (success / abort / cap / error / turn-limit) with structured
// tags + extras. Same harness pattern as agenticLimits.test.ts.

// ── Sentry mock — captures the (msg, options) pairs for assertion. ──
const captureMessage = vi.fn<(msg: string, opts?: unknown) => void>()
vi.mock('@sentry/nuxt', () => ({
  captureMessage,
  captureException: vi.fn(),
  setUser: vi.fn(),
  startSpan: vi.fn(),
  withScope: vi.fn()
}))

// Same mocks the existing limits test uses — keep the harness shape
// identical so future changes to runLoop's deps land in one place.
const executeFunctionByName = vi.fn<(session: unknown, name: string, args: unknown) => Promise<{ content: string, isError: boolean, extraParts?: unknown[] }>>()
const webSearch = vi.fn<(ai: unknown, model: string, query: string, signal: AbortSignal) => Promise<{ text: string, sources: Array<{ title: string, uri: string }> }>>()
const fetchUrl = vi.fn<(ai: unknown, model: string, url: string, signal: AbortSignal) => Promise<{ text: string, url: string, summary: string, images: Array<{ url: string, description?: string }> }>>()

vi.mock('../../server/utils/aiToolAdapter', () => ({ executeFunctionByName }))
vi.mock('../../server/utils/agentic/functionTools', async () => {
  const actual = await vi.importActual<typeof import('../../server/utils/agentic/functionTools')>(
    '../../server/utils/agentic/functionTools'
  )
  return { ...actual, webSearch, fetchUrl }
})

// `appendActivity` / `pruneActivity` / `docExists` are reached via the
// fire-and-forget `logAiTool` helper. Stub everything out so the
// telemetry path doesn't touch the DB.
vi.mock('../../server/repos/activity', () => ({
  appendActivity: vi.fn().mockResolvedValue(undefined),
  pruneActivity: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('../../server/repos/documents', () => ({
  docExists: vi.fn().mockResolvedValue(false)
}))

const { runAgenticLoop } = await import('../../server/utils/agentic/runLoop')

interface StreamChunk {
  functionCalls?: FunctionCall[]
  text?: string
  finishReason?: FinishReason
  usageMetadata?: { promptTokenCount?: number, candidatesTokenCount?: number, thoughtsTokenCount?: number }
}
interface FakeTurn { chunks: StreamChunk[] }

function makeFakeAi(turns: FakeTurn[]) {
  let cursor = 0
  return {
    models: {
      generateContentStream: async () => {
        const turn = turns[cursor++]
        if (!turn) throw new Error(`[fake-ai] unexpected call #${cursor}; only ${turns.length} scripted`)
        return {
          async* [Symbol.asyncIterator]() {
            for (const c of turn.chunks) yield shapeChunk(c)
          }
        }
      }
    }
  } as unknown as Parameters<typeof runAgenticLoop>[0]['ai']
}

function shapeChunk(c: StreamChunk): GenerateContentResponse {
  return {
    functionCalls: c.functionCalls,
    text: c.text,
    usageMetadata: c.usageMetadata,
    candidates: c.finishReason !== undefined
      ? [{ content: { parts: [] }, finishReason: c.finishReason }]
      : undefined
  } as unknown as GenerateContentResponse
}

function makeOpts(overrides: Partial<Parameters<typeof runAgenticLoop>[0]> = {}): Parameters<typeof runAgenticLoop>[0] {
  // aiSession needs `docId` + `initiatorUserId` for the telemetry tag
  // path; nothing else is touched in the success scenario.
  const aiSession = {
    docId: 'doc-abc',
    initiatorUserId: 42,
    aiProviders: FULL_AI_PROVIDERS
  } as unknown as Parameters<typeof runAgenticLoop>[0]['aiSession']
  return {
    ai: overrides.ai ?? makeFakeAi([]),
    model: 'fake-test-model',
    systemPrompt: 'system',
    initialPrompt: 'user prompt',
    aiSession,
    sessionId: 'sess-test',
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
    ...overrides
  }
}

beforeEach(() => {
  captureMessage.mockReset()
  executeFunctionByName.mockReset()
  webSearch.mockReset()
  fetchUrl.mockReset()
})

describe('AI session telemetry — Sentry.captureMessage("ai-session-completed")', () => {
  it('emits exactly one event on a successful 5-turn session with view_pages calls', async () => {
    executeFunctionByName.mockResolvedValue({ content: 'page rendered', isError: false })
    // 4 turns calling view_pages (2 per turn = 8 invocations? No,
    // view_pages cap is 3 — so script 2 view_pages over the first 2
    // turns, plain text after). The point is: dispatch view_pages
    // twice, then 2 plain text turns, then a final stop. That's a
    // 5-turn session.
    const turns: FakeTurn[] = [
      // Turn 1: 2 view_pages calls (under the 3-cap).
      {
        chunks: [{
          functionCalls: [
            { id: 'a', name: 'view_pages', args: { pages: [1] } },
            { id: 'b', name: 'view_pages', args: { pages: [2] } }
          ],
          usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 5 }
        }]
      },
      // Turns 2-4: plain text continuations (no calls), no finish so
      // the loop keeps going. We need a finishReason at some point — fake
      // it on the LAST turn so the loop exits via the success branch.
      {
        chunks: [{
          functionCalls: [{ id: 'c', name: 'view_pages', args: { pages: [3] } }],
          usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 10 }
        }]
      },
      // Turn 3: model emits no calls + finish=STOP → success exit.
      { chunks: [{ text: 'done', finishReason: FinishReason.STOP, usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 7 } }] }
    ]
    await runAgenticLoop(makeOpts({ ai: makeFakeAi(turns) }))

    expect(captureMessage).toHaveBeenCalledTimes(1)
    const [name, opts] = captureMessage.mock.calls[0]!
    expect(name).toBe('ai-session-completed')
    const o = opts as { level: string, tags: Record<string, string>, extra: Record<string, unknown> }
    expect(o.level).toBe('info')
    expect(o.tags).toMatchObject({
      component: 'ai-session',
      event: 'completed',
      outcome: 'success',
      docId: 'doc-abc',
      initiatorUserId: '42'
    })
    expect(o.extra).toMatchObject({
      sessionId: 'sess-test',
      turnCount: 3,
      // 3 view_pages attempts (2 in turn 1 + 1 in turn 2).
      toolCallCounts: { view_pages: 3 },
      // Tokens summed across all chunks that surfaced usageMetadata.
      totalInputTokens: 180, // 100 + 50 + 30
      totalOutputTokens: 37, // 20 + 10 + 7
      totalThinkingTokens: 5, // only turn 1 surfaced thoughts
      plan: 'pro',
      attributedTo: 'user:42'
    })
    expect(typeof o.extra.durationMs).toBe('number')
    expect((o.extra.durationMs as number) >= 0).toBe(true)
  })

  it('reports -1 sentinels for token totals when SDK never surfaced usageMetadata', async () => {
    const turns: FakeTurn[] = [
      // No usageMetadata on any chunk.
      { chunks: [{ text: 'hi', finishReason: FinishReason.STOP }] }
    ]
    await runAgenticLoop(makeOpts({ ai: makeFakeAi(turns) }))

    expect(captureMessage).toHaveBeenCalledTimes(1)
    const [, opts] = captureMessage.mock.calls[0]!
    const extra = (opts as { extra: Record<string, unknown> }).extra
    expect(extra.totalInputTokens).toBe(-1)
    expect(extra.totalOutputTokens).toBe(-1)
    expect(extra.totalThinkingTokens).toBe(-1)
  })

  it('tags outcome=session-cap-exceeded when the per-session interaction cap trips', async () => {
    // 11 turns × 1 charge each on a session-cap of 50: trips on the
    // 11th charge (50 + 1 = 51) — but actually each web_search turn
    // costs 5 (1 + 4), so 10 web_search turns hit 50. The 11th turn's
    // upfront +1 trips the cap.
    const turns: FakeTurn[] = []
    for (let i = 0; i < 11; i++) {
      turns.push({
        chunks: [{
          functionCalls: [{ id: `c${i}`, name: 'web_search', args: { query: 'test' } }],
          finishReason: FinishReason.STOP
        }]
      })
    }
    webSearch.mockResolvedValue({ text: 'ok', sources: [] })

    await runAgenticLoop(makeOpts({ ai: makeFakeAi(turns) }))

    expect(captureMessage).toHaveBeenCalledTimes(1)
    const [, opts] = captureMessage.mock.calls[0]!
    expect((opts as { tags: Record<string, string> }).tags.outcome).toBe('session-cap-exceeded')
  })

  it('tags outcome=aborted when the abort signal fires mid-turn', async () => {
    const ac = new AbortController()
    // Trip the abort BEFORE the loop starts: the very first while-loop
    // check sees aborted → throws. The catch path stamps outcome and
    // re-throws; the finally still emits.
    ac.abort()
    await expect(
      runAgenticLoop(makeOpts({ ai: makeFakeAi([]), abortController: ac }))
    ).rejects.toThrow(/aborted/)

    expect(captureMessage).toHaveBeenCalledTimes(1)
    const [, opts] = captureMessage.mock.calls[0]!
    const o = opts as { tags: Record<string, string>, extra: Record<string, unknown> }
    expect(o.tags.outcome).toBe('aborted')
    expect(o.extra.abortReason).toBe('signal')
  })

  it('always emits — even when the loop body throws an unrelated error', async () => {
    // Force the SDK to reject on the very first call.
    const ai = {
      models: { generateContentStream: vi.fn().mockRejectedValue(new Error('boom')) }
    } as unknown as Parameters<typeof runAgenticLoop>[0]['ai']

    await expect(runAgenticLoop(makeOpts({ ai }))).rejects.toThrow('boom')

    expect(captureMessage).toHaveBeenCalledTimes(1)
    const [, opts] = captureMessage.mock.calls[0]!
    const o = opts as { tags: Record<string, string>, extra: Record<string, unknown> }
    expect(o.tags.outcome).toBe('error')
    expect(o.extra.errorMessage).toBe('boom')
  })
})
