import { describe, it, expect, vi, beforeEach } from 'vitest'
import { FinishReason, type GenerateContentResponse, type FunctionCall } from '@google/genai'

// The runLoop imports `aiToolAdapter.executeFunctionByName` which
// transitively pulls in the DB layer (repos/documents -> useDatabase).
// Stub both adapter entry points at the module boundary so the loop
// runs with no DB, no Y.js, no outbound HTTP. Every test can program
// what each tool returns.
const executeFunctionByName = vi.fn<(session: unknown, name: string, args: unknown) => Promise<{ content: string, isError: boolean, extraParts?: unknown[] }>>()
const webSearch = vi.fn<(ai: unknown, model: string, query: string, signal: AbortSignal) => Promise<string>>()

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
    candidates: (c.finishReason !== undefined || c.parts) ? [{
      content: c.parts ? { parts: c.parts } : { parts: [] },
      finishReason: c.finishReason
    }] : undefined
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
    logger: () => {},
    ...overrides
  }
}

// --- Tests ----------------------------------------------------------------

beforeEach(() => {
  executeFunctionByName.mockReset()
  webSearch.mockReset()
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
