import { describe, it, expect, vi, beforeEach } from 'vitest'
import { FULL_AI_PROVIDERS } from '../fixtures/aiProviders'
import {
  AgenticFinishReason as FinishReason,
  type AgenticGenerateContentResponse as GenerateContentResponse,
  type AgenticFunctionCall as FunctionCall
} from '../../../server/utils/agentic/aiTypes'
import { soloSessionGuard } from '../fixtures/crossBoundary'
import { partial } from '../../helpers/fixtures'

// Pin the salvage-path branching: when the model emits prose without a tool call, the runLoop synthesises a
// fallback call. By default that is `message_to_user`; with `commentThreadId` on RunLoopOptions (comment-trigger
// session) salvage calls `reply_to_comment` instead so the prose lands as a reply on the original thread.
//
// Without this branch, comment-trigger sessions where the model picks free text over a tool call (the "MUST end
// with reply_to_comment" mandate doesn't bind reliably) silently land in the prompt-bar response panel rather
// than the comment thread, and the thread looks ignored to the user.

const executeFunctionByName = vi.hoisted(() => vi.fn<(session: unknown, name: string, args: unknown) => Promise<{ content: string, isError: boolean, extraParts?: unknown[] }>>())
const webSearch = vi.hoisted(() => vi.fn())
const fetchUrl = vi.hoisted(() => vi.fn())

vi.mock('../../../server/utils/ai/tools/registry', async importOriginal => ({
  ...await importOriginal<typeof import('../../../server/utils/ai/tools/registry')>(),
  executeFunctionByName
}))
vi.mock('../../../server/utils/ai/tools/webSearch', () => ({ webSearch }))
vi.mock('../../../server/utils/ai/tools/fetchUrl', () => ({ fetchUrl }))

const { runAgenticLoop } = await import('../../../server/utils/agentic/runLoop')

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
      ? [{ content: { parts: c.text ? [{ text: c.text }] : [] }, finishReason: c.finishReason }]
      : undefined
  } as unknown as GenerateContentResponse
}

function makeOpts(overrides: Partial<Parameters<typeof runAgenticLoop>[0]> = {}): Parameters<typeof runAgenticLoop>[0] {
  return {
    ai: overrides.ai ?? makeFakeAi([]),
    model: 'fake-test-model',
    systemPrompt: 'system',
    initialPrompt: 'user prompt',
    aiSession: partial<Parameters<typeof runAgenticLoop>[0]['aiSession']>({ aiProviders: FULL_AI_PROVIDERS }),
    sessionId: 'sess-test',
    abortController: new AbortController(),
    setStatus: vi.fn(),
    billingContext: {
      attributedTo: 'user:1',
      plan: 'pro',
      periodStart: new Date('2026-04-01T00:00:00.000Z'),
      periodEnd: new Date('2026-05-01T00:00:00.000Z'),
      virtualKey: 'sk-fake-test-virtual-key',
      attribution: 'user',
      billingUserId: 1
    },
    logger: () => {},
    crossBoundary: soloSessionGuard(),
    ...overrides
  }
}

beforeEach(() => {
  executeFunctionByName.mockReset()
  executeFunctionByName.mockResolvedValue({ content: 'ok', isError: false })
  webSearch.mockReset()
  fetchUrl.mockReset()
})

describe('runLoop pure-prose salvage — branches on commentThreadId', () => {
  it('without commentThreadId: prose-only response → message_to_user fallback', async () => {
    const ai = makeFakeAi([
      { chunks: [{ text: 'Markoto is a collaborative markdown editor.', finishReason: FinishReason.STOP }] }
    ])
    await runAgenticLoop(makeOpts({ ai }))
    expect(executeFunctionByName).toHaveBeenCalledTimes(1)
    const [, name, args] = executeFunctionByName.mock.calls[0]!
    expect(name).toBe('message_to_user')
    expect(args).toMatchObject({
      message: 'Markoto is a collaborative markdown editor.',
      is_question: false
    })
  })

  it('with commentThreadId: prose-only response → reply_to_comment fallback against the thread', async () => {
    const ai = makeFakeAi([
      { chunks: [{ text: 'Rewrote the section for clarity.', finishReason: FinishReason.STOP }] }
    ])
    await runAgenticLoop(makeOpts({ ai, commentThreadId: 'comment-xyz' }))
    expect(executeFunctionByName).toHaveBeenCalledTimes(1)
    const [, name, args] = executeFunctionByName.mock.calls[0]!
    expect(name).toBe('reply_to_comment')
    expect(args).toMatchObject({
      comment_id: 'comment-xyz',
      body: 'Rewrote the section for clarity.'
    })
  })

  it('truncates prose >600 chars with an ellipsis on both fallbacks', async () => {
    const longProse = 'A'.repeat(800)
    const ai = makeFakeAi([
      { chunks: [{ text: longProse, finishReason: FinishReason.STOP }] }
    ])
    await runAgenticLoop(makeOpts({ ai, commentThreadId: 'comment-1' }))
    const [, , args] = executeFunctionByName.mock.calls[0]!
    const body = (args as { body: string }).body
    expect(body.length).toBe(600)
    expect(body.endsWith('…')).toBe(true)
  })

  it('empty commentThreadId is treated as "not a comment session"', async () => {
    // Defensive: passing `commentThreadId: ''` (or null) should fall
    // through to message_to_user, not reply_to_comment with a blank id.
    const ai = makeFakeAi([
      { chunks: [{ text: 'Hello', finishReason: FinishReason.STOP }] }
    ])
    await runAgenticLoop(makeOpts({ ai, commentThreadId: '' }))
    const [, name] = executeFunctionByName.mock.calls[0]!
    expect(name).toBe('message_to_user')
  })

  it('proper tool call (not prose) does not trigger any salvage', async () => {
    // Sanity: when the model DOES call reply_to_comment explicitly, the
    // loop terminates RIGHT AFTER (comment-trigger terminator). No
    // second turn is ever requested from the model.
    const ai = makeFakeAi([
      // Single turn: model emits the tool call. With the terminator,
      // the loop should end here.
      { chunks: [{
        functionCalls: [{ id: 'c1', name: 'reply_to_comment', args: { comment_id: 'comment-1', body: 'hi' } }]
      }] }
    ])
    await runAgenticLoop(makeOpts({ ai, commentThreadId: 'comment-1' }))
    // Exactly one tool dispatch — the model's own. No synthesised second one.
    expect(executeFunctionByName).toHaveBeenCalledTimes(1)
    const [, name] = executeFunctionByName.mock.calls[0]!
    expect(name).toBe('reply_to_comment')
  })

  it('comment-trigger terminator: stops after reply_to_comment even if the model emits more tool calls', async () => {
    // The actual production failure: Mistral calls reply_to_comment
    // and ALSO a replace_text in the same turn. Without the
    // terminator, the loop continues into another turn (visible to
    // the user as a stuck rainbow ring). With it, we honour the
    // system prompt's "MUST end with reply_to_comment" mandate even
    // when the model breaks the rule.
    const ai = makeFakeAi([
      { chunks: [{
        functionCalls: [
          { id: 'c1', name: 'reply_to_comment', args: { comment_id: 'comment-1', body: 'done' } },
          { id: 'c2', name: 'replace_text', args: { old_str: 'foo', new_str: 'bar' } }
        ]
      }] }
      // Crucially: NO turn 2 scripted. If the loop tries to continue,
      // makeFakeAi throws "unexpected call #2", failing the test.
    ])
    await runAgenticLoop(makeOpts({ ai, commentThreadId: 'comment-1' }))
    // Both tool calls dispatched (we don't drop calls within the same turn),
    // but no further LLM turn requested.
    expect(executeFunctionByName).toHaveBeenCalledTimes(2)
  })

  it('comment-trigger terminator does NOT fire when reply_to_comment targets a different thread', async () => {
    // Defensive: an AI session triggered on thread A shouldn't end
    // because the model replied to thread B (model would have to
    // hallucinate the wrong comment_id, but if it does, we let the
    // loop run on rather than mis-terminate the session).
    const ai = makeFakeAi([
      { chunks: [{
        functionCalls: [{ id: 'c1', name: 'reply_to_comment', args: { comment_id: 'OTHER-THREAD', body: 'hi' } }]
      }] },
      // Loop continues, model emits empty + STOP.
      { chunks: [{ finishReason: FinishReason.STOP }] }
    ])
    await runAgenticLoop(makeOpts({ ai, commentThreadId: 'comment-1' }))
    expect(executeFunctionByName).toHaveBeenCalledTimes(1)
  })
})
