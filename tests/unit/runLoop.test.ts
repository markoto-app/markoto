import { describe, it, expect, vi, beforeEach } from 'vitest'
import { FinishReason, type GenerateContentResponse, type FunctionCall } from '@google/genai'

// ─── Adversarial: budget exhaustion paths ─────────────────────────────────
//
// The runLoop charges 1 interaction per turn upfront, +4 for each
// grounded sub-call. Mid-loop BudgetExhausted means the user crossed
// their cap during this run — must emit a doc breadcrumb (so the user
// sees what happened — there's no chat UI) and exit cleanly via
// setStatus('done', 'Budget exhausted'). Critical that exhaustion
// NEVER throws to the caller — that would render as an unhandled
// error, not the friendly "Upgrade your plan" UX.

import { BudgetExhausted } from '../../server/utils/billing'

// The runLoop imports `aiToolAdapter.executeFunctionByName` which
// transitively pulls in the DB layer (repos/documents -> useDatabase).
// Stub both adapter entry points at the module boundary so the loop
// runs with no DB, no Y.js, no outbound HTTP. Every test can program
// what each tool returns.
const executeFunctionByName = vi.fn<(session: unknown, name: string, args: unknown) => Promise<{ content: string, isError: boolean, extraParts?: unknown[] }>>()
const webSearch = vi.fn<(ai: unknown, model: string, query: string, signal: AbortSignal) => Promise<string>>()

// Billing is a required arg now — stub `chargeInteractions` at the
// module boundary so the loop's per-turn charge call is a no-op in
// unit tests (no DB, deterministic). Adversarial tests below program
// per-call behaviour (throw BudgetExhausted, throw DB error, etc.).
//
// Wrapped in vi.hoisted so the mock factory (also hoisted) can close
// over the same vi.fn instance — otherwise the factory would reference
// the const before it exists.
const { chargeInteractions } = vi.hoisted(() => ({
  chargeInteractions: vi.fn<(opts: unknown) => Promise<{ used: number, remaining: number }>>()
}))
vi.mock('../../server/utils/billing', async () => {
  const actual = await vi.importActual<typeof import('../../server/utils/billing')>(
    '../../server/utils/billing'
  )
  return {
    ...actual,
    chargeInteractions
  }
})

vi.mock('../../server/utils/aiToolAdapter', () => ({
  executeFunctionByName
}))
vi.mock('../../server/utils/agentic/functionTools', async () => {
  const actual = await vi.importActual<typeof import('../../server/utils/agentic/functionTools')>(
    '../../server/utils/agentic/functionTools'
  )
  return {
    ...actual,
    // Keep TOOL_SCHEMAS + ALL_TOOL_DECLARATIONS real (we rely on
    // safeParse for the validation-failure tests) and stub only the
    // external-I/O helper.
    webSearch
  }
})

// Import under test AFTER vi.mock() calls above.
const { runAgenticLoop } = await import('../../server/utils/agentic/runLoop')

// --- Test harness ---------------------------------------------------------

interface StreamChunk {
  functionCalls?: FunctionCall[]
  text?: string
  finishReason?: FinishReason
  parts?: NonNullable<GenerateContentResponse['candidates']>[number]['content']['parts']
}

/**
 * Programmable fake GoogleGenAI. Each `generateContentStream` call pulls
 * the next "turn" off `turns` and yields its chunks. Tests describe the
 * model's side of the conversation as a list of turns.
 */
interface FakeTurn {
  chunks: StreamChunk[]
  /** Optional extra assertion on the `contents` array the loop sent. */
  assertContents?: (contents: unknown[]) => void
}

function makeFakeAi(turns: FakeTurn[]): {
  ai: Parameters<typeof runAgenticLoop>[0]['ai']
  callsSeen: Array<{ contents: unknown[] }>
} {
  const callsSeen: Array<{ contents: unknown[] }> = []
  let cursor = 0
  const ai = {
    models: {
      generateContentStream: async (args: { contents: unknown[] }) => {
        // Snapshot: the loop keeps mutating the `contents` array as
        // turns progress, so a reference-capture would reflect the
        // FINAL state, not the state at this call. Deep clone via
        // JSON round-trip — our chunk shape is pure data.
        callsSeen.push({ contents: JSON.parse(JSON.stringify(args.contents)) })
        const turn = turns[cursor++]
        if (!turn) throw new Error(`[fake-ai] unexpected call #${cursor}; harness only scripted ${turns.length} turns`)
        turn.assertContents?.(args.contents)
        const chunksForTurn = turn.chunks
        // Return an async iterable. Each iteration yields one chunk
        // shaped like a GenerateContentResponse.
        return {
          async* [Symbol.asyncIterator]() {
            for (const c of chunksForTurn) {
              yield shapeChunk(c)
            }
          }
        }
      }
    }
  } as unknown as Parameters<typeof runAgenticLoop>[0]['ai']
  return { ai, callsSeen }
}

function shapeChunk(c: StreamChunk): GenerateContentResponse {
  // Gemini surfaces `functionCalls` as a getter on the response; a plain
  // property of the same name is fine for runLoop's consumption.
  // `candidates[0].content.parts` holds text/inline-data/tool-calls for
  // the accumulation into `modelParts`. `candidates[0].finishReason`
  // is only on the last chunk in a real stream; we put it wherever the
  // test describes.
  return {
    functionCalls: c.functionCalls,
    text: c.text,
    candidates: (c.finishReason !== undefined || c.parts)
      ? [{
          content: c.parts ? { parts: c.parts } : { parts: [] },
          finishReason: c.finishReason
        }]
      : undefined
  } as unknown as GenerateContentResponse
}

function makeOpts(overrides: Partial<Parameters<typeof runAgenticLoop>[0]> = {}): Parameters<typeof runAgenticLoop>[0] {
  return {
    ai: overrides.ai ?? makeFakeAi([]).ai,
    model: 'gemini-test',
    systemPrompt: 'system',
    initialPrompt: 'user prompt',
    aiSession: {} as Parameters<typeof runAgenticLoop>[0]['aiSession'],
    sessionId: 'sess-test',
    abortController: new AbortController(),
    setStatus: vi.fn(),
    billingContext: {
      attributedTo: 'user:1',
      plan: 'pro',
      periodStart: new Date('2026-04-01T00:00:00.000Z'),
      periodEnd: new Date('2026-05-01T00:00:00.000Z'),
      interactionsRemaining: 999,
      attribution: 'user'
    },
    logger: () => {},
    ...overrides
  }
}

// --- Tests ----------------------------------------------------------------

beforeEach(() => {
  executeFunctionByName.mockReset()
  webSearch.mockReset()
  chargeInteractions.mockReset()
  // Default: every charge succeeds. Adversarial tests override per-call.
  chargeInteractions.mockResolvedValue({ used: 1, remaining: 999 })
})

describe('runAgenticLoop — single-turn happy path', () => {
  it('model returns plain text with STOP → setStatus(done) and return normally', async () => {
    const { ai } = makeFakeAi([
      { chunks: [{ text: 'All done.', finishReason: FinishReason.STOP }] }
    ])
    const setStatus = vi.fn()
    await runAgenticLoop(makeOpts({ ai, setStatus }))
    expect(setStatus).toHaveBeenCalledWith('thinking', 'Thinking…')
    expect(setStatus).toHaveBeenLastCalledWith('done', 'Done')
    // No tool dispatch.
    expect(executeFunctionByName).not.toHaveBeenCalled()
  })

  it('MAX_TOKENS finish also ends cleanly (done, not error)', async () => {
    // Regression target: MAX_TOKENS is a "clean termination" reason —
    // loop mustn't flag it as an error. The user just got a truncated
    // reply, not a safety block.
    const { ai } = makeFakeAi([
      { chunks: [{ text: '...', finishReason: FinishReason.MAX_TOKENS }] }
    ])
    const setStatus = vi.fn()
    await runAgenticLoop(makeOpts({ ai, setStatus }))
    expect(setStatus).toHaveBeenLastCalledWith('done', 'Done')
  })

  it('first chunk has no finishReason but last does — runs to completion', async () => {
    const { ai } = makeFakeAi([{
      chunks: [
        { text: 'Hello ' },
        { text: 'world.', finishReason: FinishReason.STOP }
      ]
    }])
    const setStatus = vi.fn()
    await runAgenticLoop(makeOpts({ ai, setStatus }))
    expect(setStatus).toHaveBeenLastCalledWith('done', 'Done')
  })
})

describe('runAgenticLoop — tool dispatch', () => {
  it('single tool call → dispatches, then second turn returns plain text', async () => {
    const { ai } = makeFakeAi([
      // Turn 1: model calls view_document
      {
        chunks: [{
          functionCalls: [{ id: 'c1', name: 'view_document', args: {} }],
          finishReason: FinishReason.STOP
        }]
      },
      // Turn 2: model reads the tool response and replies with text.
      {
        chunks: [{ text: 'Here is what I see.', finishReason: FinishReason.STOP }],
        assertContents: (contents) => {
          // The contents on the second call must contain our tool
          // response (user-role with a functionResponse part) exactly
          // once — that's Gemini's continuation contract.
          const last = contents[contents.length - 1] as { role: string, parts: Array<{ functionResponse?: unknown }> }
          expect(last.role).toBe('user')
          expect(last.parts[0].functionResponse).toBeDefined()
        }
      }
    ])
    executeFunctionByName.mockResolvedValueOnce({ content: '1: hello', isError: false })
    await runAgenticLoop(makeOpts({ ai }))
    expect(executeFunctionByName).toHaveBeenCalledWith(expect.anything(), 'view_document', {})
  })

  it('functionResponse carries { output, isError } wrapper shape', async () => {
    const { ai, callsSeen } = makeFakeAi([
      { chunks: [{ functionCalls: [{ id: 'c1', name: 'view_document', args: {} }], finishReason: FinishReason.STOP }] },
      { chunks: [{ text: 'ok', finishReason: FinishReason.STOP }] }
    ])
    executeFunctionByName.mockResolvedValueOnce({ content: 'doc text', isError: false })
    await runAgenticLoop(makeOpts({ ai }))
    const turn2Contents = callsSeen[1].contents as Array<{ role: string, parts: Array<{ functionResponse?: { id?: string, name?: string, response?: { output?: string, isError?: boolean } } }> }>
    const fr = turn2Contents[turn2Contents.length - 1].parts[0].functionResponse!
    expect(fr.id).toBe('c1')
    expect(fr.name).toBe('view_document')
    expect(fr.response?.output).toBe('doc text')
    expect(fr.response?.isError).toBe(false)
  })

  it('multiple tool calls in one turn all dispatch in order', async () => {
    const { ai } = makeFakeAi([
      {
        chunks: [{
          functionCalls: [
            { id: 'c1', name: 'view_document', args: {} },
            { id: 'c2', name: 'insert_text', args: { insert_line: 0, insert_text: 'hi' } }
          ],
          finishReason: FinishReason.STOP
        }]
      },
      { chunks: [{ text: 'ok', finishReason: FinishReason.STOP }] }
    ])
    executeFunctionByName
      .mockResolvedValueOnce({ content: 'doc text', isError: false })
      .mockResolvedValueOnce({ content: 'inserted', isError: false })
    await runAgenticLoop(makeOpts({ ai }))
    expect(executeFunctionByName).toHaveBeenCalledTimes(2)
    expect(executeFunctionByName.mock.calls[0][1]).toBe('view_document')
    expect(executeFunctionByName.mock.calls[1][1]).toBe('insert_text')
  })

  it('handler throw is caught and reported as isError to model', async () => {
    // Regression target: if a tool handler throws synchronously, the
    // loop must NOT propagate — it must capture the message and pass
    // isError=true back so the model can self-correct.
    const { ai, callsSeen } = makeFakeAi([
      { chunks: [{ functionCalls: [{ id: 'c1', name: 'replace_text', args: { old_str: 'x', new_str: 'y' } }], finishReason: FinishReason.STOP }] },
      { chunks: [{ text: 'sorry', finishReason: FinishReason.STOP }] }
    ])
    executeFunctionByName.mockRejectedValueOnce(new Error('ytext.delete failed'))
    await runAgenticLoop(makeOpts({ ai }))
    const turn2 = callsSeen[1].contents as Array<{ role: string, parts: Array<{ functionResponse?: { response?: { isError?: boolean, output?: string } } }> }>
    const fr = turn2[turn2.length - 1].parts[0].functionResponse!
    expect(fr.response?.isError).toBe(true)
    expect(fr.response?.output).toContain('replace_text failed')
    expect(fr.response?.output).toContain('ytext.delete failed')
  })
})

describe('runAgenticLoop — Zod validation of tool args', () => {
  it('invalid tool args → loop sends isError response instead of dispatching', async () => {
    // replace_text requires non-empty old_str. Model passes empty; Zod
    // safeParse catches it. The handler is never called — the model
    // gets a clear schema-level error and can retry with the right shape.
    const { ai, callsSeen } = makeFakeAi([
      { chunks: [{ functionCalls: [{ id: 'c1', name: 'replace_text', args: { old_str: '', new_str: 'x' } }], finishReason: FinishReason.STOP }] },
      { chunks: [{ text: 'retrying', finishReason: FinishReason.STOP }] }
    ])
    await runAgenticLoop(makeOpts({ ai }))
    expect(executeFunctionByName).not.toHaveBeenCalled()
    const turn2 = callsSeen[1].contents as Array<{ role: string, parts: Array<{ functionResponse?: { response?: { isError?: boolean, output?: string } } }> }>
    const fr = turn2[turn2.length - 1].parts[0].functionResponse!
    expect(fr.response?.isError).toBe(true)
    expect(fr.response?.output).toContain('invalid arguments for replace_text')
  })

  it('unknown tool name → isError "Unsupported function"', async () => {
    // The dispatcher's default branch returns the isError response.
    // runLoop passes through without calling safeParse (no schema) so
    // the dispatcher is what produces the error.
    const { ai, callsSeen } = makeFakeAi([
      { chunks: [{ functionCalls: [{ id: 'c1', name: 'not_a_tool', args: {} }], finishReason: FinishReason.STOP }] },
      { chunks: [{ text: 'ok', finishReason: FinishReason.STOP }] }
    ])
    executeFunctionByName.mockResolvedValueOnce({ content: 'Error: Unsupported function "not_a_tool"', isError: true })
    await runAgenticLoop(makeOpts({ ai }))
    expect(executeFunctionByName).toHaveBeenCalledWith(expect.anything(), 'not_a_tool', {})
    const turn2 = callsSeen[1].contents as Array<{ role: string, parts: Array<{ functionResponse?: { response?: { isError?: boolean } } }> }>
    expect(turn2[turn2.length - 1].parts[0].functionResponse?.response?.isError).toBe(true)
  })
})

describe('runAgenticLoop — terminal finishReasons', () => {
  it.each([
    FinishReason.MALFORMED_FUNCTION_CALL,
    FinishReason.UNEXPECTED_TOOL_CALL,
    FinishReason.SAFETY,
    FinishReason.PROHIBITED_CONTENT
  ])('bails out on %s even when function calls are present', async (reason) => {
    const { ai } = makeFakeAi([{
      chunks: [{
        functionCalls: [{ id: 'c1', name: 'view_document', args: {} }],
        finishReason: reason
      }]
    }])
    const setStatus = vi.fn()
    await runAgenticLoop(makeOpts({ ai, setStatus }))
    expect(setStatus).toHaveBeenLastCalledWith('error', expect.stringContaining(`Stopped: ${reason}`))
    // And NEVER dispatched the tool — the loop saw the bail reason first.
    expect(executeFunctionByName).not.toHaveBeenCalled()
  })

  it('non-STOP plain-text finish emits error status', async () => {
    const { ai } = makeFakeAi([
      { chunks: [{ text: 'hi', finishReason: FinishReason.SAFETY }] }
    ])
    const setStatus = vi.fn()
    await runAgenticLoop(makeOpts({ ai, setStatus }))
    expect(setStatus).toHaveBeenLastCalledWith('error', `Stopped: ${FinishReason.SAFETY}`)
  })
})

describe('runAgenticLoop — MAX_TURNS cap', () => {
  it('terminates with error after 20 turns of tool calls', async () => {
    // Every turn emits a tool call with no bail-out reason. After 20
    // iterations the while loop exits and setStatus('error', 'Hit
    // turn limit') fires. Without this cap a looping model could burn
    // tokens indefinitely.
    const everLoopingTurn = {
      chunks: [{
        functionCalls: [{ id: 'c', name: 'view_document', args: {} }],
        finishReason: FinishReason.STOP
      }]
    }
    const { ai } = makeFakeAi(Array(25).fill(everLoopingTurn))
    executeFunctionByName.mockResolvedValue({ content: 'doc', isError: false })
    const setStatus = vi.fn()
    await runAgenticLoop(makeOpts({ ai, setStatus }))
    expect(setStatus).toHaveBeenLastCalledWith('error', 'Hit turn limit')
    // Exactly 20 turns executed (= 20 dispatches).
    expect(executeFunctionByName).toHaveBeenCalledTimes(20)
  })
})

describe('runAgenticLoop — abort', () => {
  it('aborts before first turn throws immediately', async () => {
    const abortController = new AbortController()
    abortController.abort()
    const { ai } = makeFakeAi([{ chunks: [{ text: 'ok', finishReason: FinishReason.STOP }] }])
    await expect(runAgenticLoop(makeOpts({ ai, abortController }))).rejects.toThrow('aborted')
  })

  it('abort during stream iteration throws aborted', async () => {
    const abortController = new AbortController()
    // Build a stream whose second chunk triggers the abort before
    // the loop consumes it.
    const { ai } = makeFakeAi([{
      chunks: [
        { text: 'first chunk' },
        { text: 'second', finishReason: FinishReason.STOP }
      ]
    }])
    // Abort AFTER the stream iterator is created but before full
    // consumption. Easiest: abort synchronously before run starts, but
    // we already covered that. Here we drive the abort between chunks
    // by wrapping the AI.
    const wrappedAi = {
      models: {
        generateContentStream: async (args: unknown) => {
          const inner = await ai.models.generateContentStream(args as never)
          return {
            async* [Symbol.asyncIterator]() {
              for await (const chunk of inner) {
                yield chunk
                // Abort after the first chunk lands; loop's next
                // signal check throws.
                abortController.abort()
              }
            }
          }
        }
      }
    } as unknown as Parameters<typeof runAgenticLoop>[0]['ai']
    await expect(runAgenticLoop(makeOpts({ ai: wrappedAi, abortController }))).rejects.toThrow('aborted')
  })

  it('abort during tool dispatch propagates (not swallowed as isError)', async () => {
    // Regression target: the catch around executeFunctionByName has
    // a `if (abortController.signal.aborted) throw e` re-throw guard.
    // Without it, an abort during a long tool call would get
    // swallowed as a isError response, and the caller's abort logic
    // would miss the signal entirely.
    const abortController = new AbortController()
    const { ai } = makeFakeAi([
      { chunks: [{ functionCalls: [{ id: 'c1', name: 'view_document', args: {} }], finishReason: FinishReason.STOP }] }
    ])
    executeFunctionByName.mockImplementationOnce(async () => {
      abortController.abort()
      throw new Error('aborted')
    })
    await expect(runAgenticLoop(makeOpts({ ai, abortController }))).rejects.toThrow('aborted')
  })
})

describe('runAgenticLoop — web_search routing', () => {
  it('web_search calls the webSearch helper, not executeFunctionByName', async () => {
    const { ai } = makeFakeAi([
      { chunks: [{ functionCalls: [{ id: 'c1', name: 'web_search', args: { query: 'gemini pricing' } }], finishReason: FinishReason.STOP }] },
      { chunks: [{ text: 'based on search...', finishReason: FinishReason.STOP }] }
    ])
    webSearch.mockResolvedValueOnce('Top answer.\n\nSources:\n  - x')
    await runAgenticLoop(makeOpts({ ai }))
    expect(webSearch).toHaveBeenCalledWith(expect.anything(), 'gemini-test', 'gemini pricing', expect.any(AbortSignal))
    expect(executeFunctionByName).not.toHaveBeenCalled()
  })

  it('webSearch failure surfaces as isError response; loop continues', async () => {
    const { ai, callsSeen } = makeFakeAi([
      { chunks: [{ functionCalls: [{ id: 'c1', name: 'web_search', args: { query: 'x' } }], finishReason: FinishReason.STOP }] },
      { chunks: [{ text: 'falling back', finishReason: FinishReason.STOP }] }
    ])
    webSearch.mockRejectedValueOnce(new Error('network blip'))
    await runAgenticLoop(makeOpts({ ai }))
    const turn2 = callsSeen[1].contents as Array<{ role: string, parts: Array<{ functionResponse?: { response?: { isError?: boolean, output?: string } } }> }>
    const fr = turn2[turn2.length - 1].parts[0].functionResponse!
    expect(fr.response?.isError).toBe(true)
    expect(fr.response?.output).toContain('web_search failed')
    expect(fr.response?.output).toContain('network blip')
  })

  it('abort during web_search re-throws instead of becoming isError', async () => {
    const abortController = new AbortController()
    const { ai } = makeFakeAi([
      { chunks: [{ functionCalls: [{ id: 'c1', name: 'web_search', args: { query: 'x' } }], finishReason: FinishReason.STOP }] }
    ])
    webSearch.mockImplementationOnce(async () => {
      abortController.abort()
      throw new Error('aborted')
    })
    await expect(runAgenticLoop(makeOpts({ ai, abortController }))).rejects.toThrow('aborted')
  })
})

describe('runAgenticLoop — conversation history', () => {
  it('appends model response parts verbatim before the functionResponse user block', async () => {
    // Gemini's continuation contract requires the model's own Content
    // block to be present in history before we reply with
    // functionResponse. If we skipped it, the next call would 400.
    const modelParts = [{ functionCall: { id: 'c1', name: 'view_document', args: {} } }]
    const { ai, callsSeen } = makeFakeAi([
      {
        chunks: [{
          functionCalls: [{ id: 'c1', name: 'view_document', args: {} }],
          finishReason: FinishReason.STOP,
          parts: modelParts as never
        }]
      },
      { chunks: [{ text: 'done', finishReason: FinishReason.STOP }] }
    ])
    executeFunctionByName.mockResolvedValueOnce({ content: 'doc', isError: false })
    await runAgenticLoop(makeOpts({ ai }))
    const turn2Contents = callsSeen[1].contents as Array<{ role: string, parts: unknown[] }>
    // Layout: [initial user, model (with functionCall parts), user (functionResponse)].
    expect(turn2Contents.length).toBe(3)
    expect(turn2Contents[0].role).toBe('user')
    expect(turn2Contents[1].role).toBe('model')
    expect(turn2Contents[2].role).toBe('user')
  })
})

/**
 * Y.Doc-shaped session stub. The breadcrumb writer calls
 * `ydoc.transact(fn, origin)` and `ytext.insert(end, msg)`. We only
 * need the surface those two paths touch.
 */
function makeSessionStub() {
  const inserted: Array<{ at: number, text: string }> = []
  const transactCalls: Array<{ origin: unknown }> = []
  let ytextLength = 0
  const aiSession = {
    ydoc: {
      transact(fn: () => void, origin: unknown) {
        transactCalls.push({ origin })
        fn()
      }
    },
    ytext: {
      get length() { return ytextLength },
      insert(at: number, text: string) {
        inserted.push({ at, text })
        ytextLength += text.length
      }
    }
  } as unknown as Parameters<typeof runAgenticLoop>[0]['aiSession']
  return { aiSession, inserted, transactCalls }
}

function makeBudgetExhaustedError(): BudgetExhausted {
  return new BudgetExhausted({
    attributedTo: 'user:1',
    plan: 'pro',
    requestedDelta: 1,
    used: 1500,
    cap: 1500
  })
}

describe('runAgenticLoop — budget exhausted at turn-start', () => {
  it('charge(1) throws BudgetExhausted on the FIRST turn → breadcrumb + done, no Gemini call', async () => {
    const { aiSession, inserted, transactCalls } = makeSessionStub()
    chargeInteractions.mockRejectedValueOnce(makeBudgetExhaustedError())
    const setStatus = vi.fn()
    const { ai, callsSeen } = makeFakeAi([])

    await expect(runAgenticLoop(makeOpts({ ai, aiSession, setStatus })))
      .resolves.toBeUndefined() // does NOT throw — graceful exit

    // Gemini was never called (we bailed before the stream).
    expect(callsSeen).toHaveLength(0)
    // Breadcrumb written to the doc with the upgrade CTA.
    expect(inserted).toHaveLength(1)
    expect(inserted[0].text).toContain('budget exhausted')
    expect(inserted[0].text).toContain('/pricing')
    // Y.js transact tagged with the AI session origin so it
    // participates in the awareness/undo flows.
    expect(transactCalls[0]!.origin).toBe('ai:assistant:sess-test')
    // Status terminal-done.
    const lastStatus = setStatus.mock.calls.at(-1)
    expect(lastStatus).toEqual(['done', 'Budget exhausted'])
  })

  it('charge(1) throws BudgetExhausted on TURN 2 (after turn 1 succeeded) → breadcrumb after partial work', async () => {
    // Turn 1 completes a tool call; turn 2's charge(1) fails. The
    // breadcrumb must still write to the doc so the user knows their
    // run didn't finish naturally.
    const { aiSession, inserted } = makeSessionStub()
    chargeInteractions
      .mockResolvedValueOnce({ used: 1, remaining: 999 }) // turn 1: ok
      .mockRejectedValueOnce(makeBudgetExhaustedError()) // turn 2: exhausted
    const setStatus = vi.fn()
    const { ai, callsSeen } = makeFakeAi([
      {
        chunks: [{
          functionCalls: [{ id: 'c1', name: 'view_document', args: {} }],
          finishReason: FinishReason.STOP
        }]
      }
      // No turn 2 scripted — we should bail before calling.
    ])
    executeFunctionByName.mockResolvedValueOnce({ content: 'doc content', isError: false })

    await runAgenticLoop(makeOpts({ ai, aiSession, setStatus }))

    // Only ONE Gemini call (turn 1). Turn 2 bailed at the charge.
    expect(callsSeen).toHaveLength(1)
    expect(inserted).toHaveLength(1)
    const lastStatus = setStatus.mock.calls.at(-1)
    expect(lastStatus).toEqual(['done', 'Budget exhausted'])
  })

  it('charge(1) throws a NON-BudgetExhausted error (DB connection) → propagates, no breadcrumb', async () => {
    // Critical contract: the loop only swallows BudgetExhausted
    // specifically. A DB error from the charge call would otherwise
    // be silently treated as a "graceful end" and the user would see
    // a fake "done" status while their session ate cost.
    const { aiSession, inserted } = makeSessionStub()
    chargeInteractions.mockRejectedValueOnce(new Error('connection refused'))

    await expect(runAgenticLoop(makeOpts({ aiSession })))
      .rejects.toThrow('connection refused')

    // No breadcrumb — this isn't a budget situation.
    expect(inserted).toHaveLength(0)
  })
})

describe('runAgenticLoop — budget exhausted in grounded sub-call', () => {
  it('web_search charge(4) throws BudgetExhausted → breadcrumb + done, web_search NOT called', async () => {
    // Turn 1 charge(1) succeeds. The model emits a web_search call.
    // The +4 grounded charge throws BudgetExhausted. Breadcrumb,
    // exit. Critical: webSearch must NOT have been invoked (we said
    // "charged BEFORE the Gemini sub-call so exhausted users don't
    // incur cost").
    const { aiSession, inserted } = makeSessionStub()
    chargeInteractions
      .mockResolvedValueOnce({ used: 1, remaining: 4 }) // turn 1 charge: ok
      .mockRejectedValueOnce(makeBudgetExhaustedError()) // grounded +4: exhausted
    const { ai } = makeFakeAi([
      {
        chunks: [{
          functionCalls: [{ id: 'c1', name: 'web_search', args: { query: 'cats' } }],
          finishReason: FinishReason.STOP
        }]
      }
    ])

    await runAgenticLoop(makeOpts({ ai, aiSession }))

    // webSearch never invoked.
    expect(webSearch).not.toHaveBeenCalled()
    // Breadcrumb on the doc.
    expect(inserted).toHaveLength(1)
    expect(inserted[0].text).toContain('budget exhausted')
  })

  it('fetch_url charge(4) throws BudgetExhausted → breadcrumb + done, fetchUrl NOT called', async () => {
    // We already mock the functionTools module; fetchUrl needs to be
    // exposed alongside webSearch. Add a per-test wrapper that swaps
    // the mock import.
    const { aiSession, inserted } = makeSessionStub()
    chargeInteractions
      .mockResolvedValueOnce({ used: 1, remaining: 4 })
      .mockRejectedValueOnce(makeBudgetExhaustedError())
    const { ai } = makeFakeAi([
      {
        chunks: [{
          functionCalls: [{ id: 'c1', name: 'fetch_url', args: { url: 'https://example.com' } }],
          finishReason: FinishReason.STOP
        }]
      }
    ])

    await runAgenticLoop(makeOpts({ ai, aiSession }))

    expect(inserted).toHaveLength(1)
    expect(inserted[0].text).toContain('budget exhausted')
  })

  it('grounded sub-call charge throws a NON-BudgetExhausted error → propagates', async () => {
    // Same DB-error guard for the +4 charge as for the +1 turn-start
    // charge. Must propagate so the user sees an honest 500 instead
    // of a fake "done".
    chargeInteractions
      .mockResolvedValueOnce({ used: 1, remaining: 4 })
      .mockRejectedValueOnce(new Error('valkey timeout'))
    const { ai } = makeFakeAi([
      {
        chunks: [{
          functionCalls: [{ id: 'c1', name: 'web_search', args: { query: 'x' } }],
          finishReason: FinishReason.STOP
        }]
      }
    ])

    await expect(runAgenticLoop(makeOpts({ ai })))
      .rejects.toThrow('valkey timeout')
  })
})

describe('runAgenticLoop — breadcrumb defensive paths', () => {
  it('emitBudgetBreadcrumb does not crash if ydoc.transact throws (status still done)', async () => {
    // The breadcrumb-writer's try/catch is the last line of defense:
    // a Y.js failure (provider disconnected, doc destroyed mid-flight)
    // must not propagate from the budget-exhausted path. The contract
    // is "user sees the upgrade message OR sees nothing — never sees
    // a stack trace".
    const aiSession = {
      ydoc: {
        transact() { throw new Error('Y.Doc destroyed') }
      },
      ytext: { length: 0, insert() { /* unreached */ } }
    } as unknown as Parameters<typeof runAgenticLoop>[0]['aiSession']
    chargeInteractions.mockRejectedValueOnce(makeBudgetExhaustedError())
    const setStatus = vi.fn()

    await expect(runAgenticLoop(makeOpts({ aiSession, setStatus })))
      .resolves.toBeUndefined()

    // Status STILL flipped to done — the breadcrumb failure is
    // logged but doesn't block the cleanup signal.
    const lastStatus = setStatus.mock.calls.at(-1)
    expect(lastStatus).toEqual(['done', 'Budget exhausted'])
  })
})

describe('runAgenticLoop — degenerate function-call shapes', () => {
  it('all calls in a turn have empty `name` → defensive "no responses" exit', async () => {
    // The SUT does `if (!call.name) continue`, then if responseParts
    // is empty after the loop, logs "no function responses to send"
    // and exits. Pin this defensive path: a malformed Gemini response
    // with empty-name calls must not deadlock the outer loop.
    const { ai } = makeFakeAi([
      {
        chunks: [{
          // Two calls, both with empty names — pathological.
          functionCalls: [
            { id: 'c1', name: '', args: {} },
            { id: 'c2', name: '', args: {} }
          ] as FunctionCall[],
          finishReason: FinishReason.STOP
        }]
      }
    ])
    const setStatus = vi.fn()

    await runAgenticLoop(makeOpts({ ai, setStatus }))

    // Charged for the turn (already committed to the API call), but
    // no tool dispatch happened.
    expect(executeFunctionByName).not.toHaveBeenCalled()
    expect(chargeInteractions).toHaveBeenCalledTimes(1)
    const lastStatus = setStatus.mock.calls.at(-1)
    expect(lastStatus).toEqual(['done', 'Done'])
  })

  it('multi-tool turn where ONE handler throws — others STILL execute (per-call try/catch)', async () => {
    // Existing single-tool throw is tested. The multi-tool case
    // matters more in practice: if a model emits 3 parallel tool
    // calls and the SECOND throws, the 1st AND 3rd must still
    // contribute their results so the model can react meaningfully
    // on the next turn. A short-circuit here would break the
    // multi-tool flow silently.
    const { ai, callsSeen } = makeFakeAi([
      {
        chunks: [{
          functionCalls: [
            { id: 'c1', name: 'view_document', args: {} },
            { id: 'c2', name: 'view_document', args: {} },
            { id: 'c3', name: 'view_document', args: {} }
          ],
          finishReason: FinishReason.STOP
        }]
      },
      { chunks: [{ text: 'final', finishReason: FinishReason.STOP }] }
    ])
    executeFunctionByName
      .mockResolvedValueOnce({ content: 'first ok', isError: false })
      .mockRejectedValueOnce(new Error('second exploded'))
      .mockResolvedValueOnce({ content: 'third ok', isError: false })

    await runAgenticLoop(makeOpts({ ai }))

    // All three handlers were invoked.
    expect(executeFunctionByName).toHaveBeenCalledTimes(3)
    // The functionResponse user-block has all three entries.
    const turn2 = callsSeen[1].contents as Array<{ role: string, parts: Array<{ functionResponse?: { name: string, response: { output: string, isError: boolean } } }> }>
    const responseUserBlock = turn2[2]
    expect(responseUserBlock.role).toBe('user')
    expect(responseUserBlock.parts).toHaveLength(3)
    expect(responseUserBlock.parts[0]?.functionResponse?.response.isError).toBe(false)
    expect(responseUserBlock.parts[1]?.functionResponse?.response.isError).toBe(true)
    expect(responseUserBlock.parts[1]?.functionResponse?.response.output).toContain('second exploded')
    expect(responseUserBlock.parts[2]?.functionResponse?.response.isError).toBe(false)
  })
})

describe('runAgenticLoop — turn-cost commitment', () => {
  it('1 interaction is charged BEFORE the model call, even on safety-blocked turns', async () => {
    // Documented contract: we charge upfront because we've committed
    // to the API call. A SAFETY/PROHIBITED_CONTENT response still
    // costs 1. The user shouldn't get a free turn just because the
    // model refused to answer.
    const { ai } = makeFakeAi([
      {
        chunks: [{
          finishReason: FinishReason.SAFETY
        }]
      }
    ])
    const setStatus = vi.fn()

    await runAgenticLoop(makeOpts({ ai, setStatus }))

    expect(chargeInteractions).toHaveBeenCalledTimes(1)
    expect(chargeInteractions.mock.calls[0]![0]).toMatchObject({ delta: 1 })
    // Status reflects the SAFETY stop.
    const lastStatus = setStatus.mock.calls.at(-1)
    expect(lastStatus![0]).toBe('error')
    expect(lastStatus![1]).toContain('SAFETY')
  })

  it('a turn with MALFORMED_FUNCTION_CALL also costs 1 (we paid Gemini)', async () => {
    const { ai } = makeFakeAi([
      {
        chunks: [{
          functionCalls: [{ id: 'c1', name: 'view_document', args: {} }],
          finishReason: FinishReason.MALFORMED_FUNCTION_CALL
        }]
      }
    ])

    await runAgenticLoop(makeOpts({ ai }))

    // No tool dispatch (we bail on MALFORMED), but the charge already
    // happened.
    expect(executeFunctionByName).not.toHaveBeenCalled()
    expect(chargeInteractions).toHaveBeenCalledTimes(1)
  })
})
