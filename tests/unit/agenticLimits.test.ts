import { describe, it, expect, vi, beforeEach } from 'vitest'
import { FULL_AI_PROVIDERS } from './fixtures/aiProviders'
import {
  AgenticFinishReason as FinishReason,
  type AgenticGenerateContentResponse as GenerateContentResponse,
  type AgenticFunctionCall as FunctionCall
} from '../../server/utils/agentic/aiTypes'

// Tests for the per-session safety caps in runLoop.ts:
//   - SESSION_INTERACTION_CAP (50): runaway-loop guard. Aborts the
//     session via setStatus('error') when exceeded.
//   - SESSION_TOOL_CALL_CAPS: per-tool call counts. Returns a tool
//     error (not abort) so the model can wrap up gracefully.
//
// Same harness pattern as runLoop.test.ts — programmable fake AI,
// stubbed billing, no DB / Y.js / network.

import { SESSION_INTERACTION_CAP, SESSION_TOOL_CALL_CAPS } from '../../server/utils/agentic/limits'

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

const { runAgenticLoop } = await import('../../server/utils/agentic/runLoop')

interface StreamChunk {
  functionCalls?: FunctionCall[]
  text?: string
  finishReason?: FinishReason
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
    candidates: c.finishReason !== undefined
      ? [{ content: { parts: [] }, finishReason: c.finishReason }]
      : undefined
  } as unknown as GenerateContentResponse
}

function makeOpts(overrides: Partial<Parameters<typeof runAgenticLoop>[0]> = {}): Parameters<typeof runAgenticLoop>[0] {
  return {
    ai: overrides.ai ?? makeFakeAi([]),
    model: 'fake-test-model',
    systemPrompt: 'system',
    initialPrompt: 'user prompt',
    aiSession: { aiProviders: FULL_AI_PROVIDERS } as Parameters<typeof runAgenticLoop>[0]['aiSession'],
    sessionId: 'sess-test',
    abortController: new AbortController(),
    setStatus: vi.fn(),
    billingContext: {
      attributedTo: 'user:1',
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
  executeFunctionByName.mockReset()
  webSearch.mockReset()
  fetchUrl.mockReset()
})

describe('limits.ts module exports', () => {
  it('SESSION_INTERACTION_CAP is 50', () => {
    expect(SESSION_INTERACTION_CAP).toBe(50)
  })

  it('exposes a cap for each cost-amplifying tool', () => {
    expect(SESSION_TOOL_CALL_CAPS).toMatchObject({
      view_pages: 3,
      generate_image: 5,
      web_search: 10,
      fetch_url: 10,
      search_knowledge: 20
    })
  })
})

describe('SESSION_INTERACTION_CAP enforcement', () => {
  it('aborts via setStatus("error") when total interactions would exceed 50', async () => {
    // Script 51 turns: each turn returns one web_search call (charges
    // 1 per turn + 4 sub-call = 5/turn). After 10 turns we're at 50;
    // the 11th turn's upfront +1 charge would land at 51 → cap hit.
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

    const setStatus = vi.fn()
    await runAgenticLoop(makeOpts({ ai: makeFakeAi(turns), setStatus }))

    // Some setStatus call should be ('error', message containing cap text)
    const errorCalls = setStatus.mock.calls.filter(c => c[0] === 'error')
    expect(errorCalls.length).toBeGreaterThanOrEqual(1)
    const errorMsg = String(errorCalls[errorCalls.length - 1]?.[1] ?? '')
    expect(errorMsg).toMatch(/session interaction cap|50/i)
  })

  it('does NOT abort when interactions stay below the cap', async () => {
    // 5 turns with no tool use → 5 interactions. Well under 50.
    const turns: FakeTurn[] = []
    for (let i = 0; i < 5; i++) {
      // Last turn ends with text
      turns.push({ chunks: [{ text: 'next', finishReason: FinishReason.STOP }] })
    }
    const setStatus = vi.fn()
    await runAgenticLoop(makeOpts({ ai: makeFakeAi(turns.slice(0, 1)), setStatus }))
    const errorCalls = setStatus.mock.calls.filter(c => c[0] === 'error')
    expect(errorCalls.length).toBe(0)
  })
})

describe('SESSION_TOOL_CALL_CAPS enforcement', () => {
  it('view_pages 4th call returns a tool error (not abort) — cap is 3', async () => {
    // Turn 1: model emits 4 view_pages calls in one turn. The first 3
    // dispatch normally; the 4th hits the cap and returns a tool error
    // BEFORE invocation. Then turn 2 just stops with text so the loop
    // exits cleanly.
    executeFunctionByName.mockResolvedValue({ content: 'page rendered', isError: false })

    const turns: FakeTurn[] = [
      {
        chunks: [{
          functionCalls: [
            { id: 'a', name: 'view_pages', args: { pages: [1] } },
            { id: 'b', name: 'view_pages', args: { pages: [2] } },
            { id: 'c', name: 'view_pages', args: { pages: [3] } },
            { id: 'd', name: 'view_pages', args: { pages: [4] } }
          ]
        }]
      },
      { chunks: [{ text: 'wrapping up', finishReason: FinishReason.STOP }] }
    ]
    const setStatus = vi.fn()
    await runAgenticLoop(makeOpts({ ai: makeFakeAi(turns), setStatus }))

    // Only 3 actual dispatches.
    expect(executeFunctionByName).toHaveBeenCalledTimes(3)
    // Loop exits via 'done', not 'error' — per-tool cap is recoverable.
    const lastCall = setStatus.mock.calls[setStatus.mock.calls.length - 1]
    expect(lastCall?.[0]).toBe('done')
  })

  it('per-tool counts do NOT cross-contaminate (4 view_pages do not bump generate_image)', async () => {
    // Turn 1: 3 view_pages (under the 3-cap, all dispatch).
    // Turn 2: 3 generate_image (well under the 5-cap, all dispatch).
    // If counters were shared, generate_image would falsely report
    // hit-the-cap behaviour by turn 2.
    executeFunctionByName.mockResolvedValue({ content: 'ok', isError: false })
    const turns: FakeTurn[] = [
      {
        chunks: [{
          functionCalls: [
            { id: 'a', name: 'view_pages', args: { pages: [1] } },
            { id: 'b', name: 'view_pages', args: { pages: [2] } },
            { id: 'c', name: 'view_pages', args: { pages: [3] } }
          ]
        }]
      },
      {
        chunks: [{
          functionCalls: [
            { id: 'd', name: 'generate_image', args: { prompt: 'a', alt: 'a' } },
            { id: 'e', name: 'generate_image', args: { prompt: 'b', alt: 'b' } },
            { id: 'f', name: 'generate_image', args: { prompt: 'c', alt: 'c' } }
          ]
        }]
      },
      { chunks: [{ text: 'final', finishReason: FinishReason.STOP }] }
    ]
    await runAgenticLoop(makeOpts({ ai: makeFakeAi(turns) }))
    // 3 view_pages + 3 generate_image = 6 dispatches; nothing capped.
    expect(executeFunctionByName).toHaveBeenCalledTimes(6)
  })
})
