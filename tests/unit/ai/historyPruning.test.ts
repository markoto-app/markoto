import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  AgenticFinishReason as FinishReason,
  type AgenticContent as Content,
  type AgenticGenerateContentResponse as GenerateContentResponse,
  type AgenticFunctionCall as FunctionCall
} from '../../../server/utils/agentic/aiTypes'
import { pruneReadResults, prunedStub } from '../../../server/utils/agentic/loop/historyPruning'
import { PRUNE_BATCH_CHARS, PRUNE_LARGE_RESULT_CHARS } from '../../../server/utils/agentic/limits'
import { FULL_AI_PROVIDERS } from '../fixtures/aiProviders'
import { soloSessionGuard } from '../fixtures/crossBoundary'
import { partial } from '../../helpers/fixtures'

// In-session pruning of old read results (`loop/historyPruning.ts`): the
// pure pass on a hand-built history, then the loop with a fake model.

const executeFunctionByName = vi.hoisted(() => vi.fn<(session: unknown, name: string, args: unknown) => Promise<{ content: string, isError: boolean }>>())

vi.mock('../../../server/utils/ai/tools/registry', async importOriginal => ({
  ...await importOriginal<typeof import('../../../server/utils/ai/tools/registry')>(),
  executeFunctionByName
}))

const { runAgenticLoop } = await import('../../../server/utils/agentic/runLoop')

// Helpers

let nextId = 0

function call(name: string, args: Record<string, unknown>): FunctionCall {
  nextId += 1
  return { id: `c${nextId}`, name, args }
}

/** One model turn (the calls) plus its tool-result message. */
function turn(calls: Array<{ call: FunctionCall, output: string, isError?: boolean }>): Content[] {
  return [
    { role: 'model', parts: calls.map(c => ({ functionCall: { ...c.call, rawArgs: JSON.stringify(c.call.args) } })) },
    { role: 'user', parts: calls.map(c => ({ functionResponse: { id: c.call.id, name: c.call.name, response: { output: c.output, isError: c.isError ?? false } } })) }
  ]
}

function outputs(contents: Content[]): string[] {
  return contents.flatMap(m => (m.parts ?? []).flatMap((p) => {
    const out = (p.functionResponse?.response as { output?: string } | undefined)?.output
    return typeof out === 'string' ? [out] : []
  }))
}

const text = (n: number, ch = 'x'): string => ch.repeat(n)

describe('pruneReadResults', () => {
  it('leaves the history alone while the prunable total is below the batch threshold', () => {
    const contents: Content[] = [
      { role: 'user', parts: [{ text: 'prompt' }] },
      ...turn([{ call: call('read_section', { section: 's-1' }), output: text(PRUNE_LARGE_RESULT_CHARS) }]),
      ...turn([{ call: call('read_section', { section: 's-2' }), output: 'short' }]),
      ...turn([{ call: call('read_section', { section: 's-3' }), output: 'short' }])
    ]
    const before = JSON.stringify(contents)
    expect(pruneReadResults(contents)).toEqual({ prunedChars: 0, prunedResults: 0 })
    expect(JSON.stringify(contents)).toBe(before)
  })

  it('stubs every prunable result at once when the total passes the threshold, keeping the latest 2 turns and the call arguments', () => {
    const big = text(PRUNE_BATCH_CHARS / 2 + 500)
    const edit = call('replace_section', { section: 's-1', markdown: big })
    const contents: Content[] = [
      { role: 'user', parts: [{ text: 'prompt' }] },
      ...turn([{ call: call('read_section', { section: 's-1' }), output: big }, { call: edit, output: 'Replaced.' }]),
      ...turn([{ call: call('view_other_document', { doc_id: 'd1' }), output: big }]),
      ...turn([{ call: call('outline', {}), output: big }]),
      ...turn([{ call: call('read_section', { section: 's-2' }), output: big }])
    ]
    const result = pruneReadResults(contents)
    expect(result.prunedResults).toBe(2)
    const outs = outputs(contents)
    // Turn 1 was edited after the read: the stale stub.
    expect(outs[0]).toBe(prunedStub(1, true))
    // An edit result is never pruned.
    expect(outs[1]).toBe('Replaced.')
    // Another document's read: not stale, just removed.
    expect(outs[2]).toBe(prunedStub(2, false))
    // The latest two turns stay.
    expect(outs[3]).toBe(big)
    expect(outs[4]).toBe(big)
    // Tool-call arguments replay verbatim.
    const editPart = contents[1]!.parts![1]!.functionCall!
    expect(editPart.rawArgs).toBe(JSON.stringify({ section: 's-1', markdown: big }))
    // The functionResponse structure stays: id, name, isError.
    expect(contents[2]!.parts![0]!.functionResponse).toMatchObject({ id: expect.any(String), name: 'read_section', response: { isError: false } })
    expect(result.prunedChars).toBe(2 * big.length - prunedStub(1, true).length - prunedStub(2, false).length)
  })

  it('prunes a mid-size read only when superseded (by an edit or a later read of the same target)', () => {
    const mid = text(5_000)
    const contents: Content[] = [
      { role: 'user', parts: [{ text: 'prompt' }] },
      ...turn([{ call: call('read_comments', {}), output: mid }]),
      ...turn([{ call: call('read_comments', {}), output: mid }]),
      ...turn([{ call: call('view_other_document', { doc_id: 'd9' }), output: mid }]),
      ...turn([{ call: call('message_to_user', { message: 'hi' }), output: 'ok' }]),
      ...turn([{ call: call('message_to_user', { message: 'hi' }), output: 'ok' }])
    ]
    const result = pruneReadResults(contents, 1)
    expect(result.prunedResults).toBe(1)
    const outs = outputs(contents)
    expect(outs[0]).toBe(prunedStub(1, false))
    expect(outs[1]).toBe(mid)
    expect(outs[2]).toBe(mid)
  })

  it('never prunes errors or results it already stubbed', () => {
    const big = text(PRUNE_BATCH_CHARS + 500)
    const contents: Content[] = [
      { role: 'user', parts: [{ text: 'prompt' }] },
      ...turn([{ call: call('view_document', {}), output: big, isError: true }]),
      ...turn([{ call: call('view_document', {}), output: big }]),
      ...turn([{ call: call('outline', {}), output: 'a' }]),
      ...turn([{ call: call('outline', {}), output: 'b' }])
    ]
    expect(pruneReadResults(contents).prunedResults).toBe(1)
    expect(pruneReadResults(contents, 0)).toEqual({ prunedChars: 0, prunedResults: 0 })
    expect(outputs(contents)[0]).toBe(big)
  })
})

// The loop: a fake model reads a section and rewrites it, turn after turn.

const SECTION_CHARS = 12_000

function fakeAi(turns: FunctionCall[][]): { ai: NonNullable<Parameters<typeof runAgenticLoop>[0]['ai']>, seen: Content[][] } {
  const seen: Content[][] = []
  let cursor = 0
  const ai = {
    models: {
      generateContentStream: async (args: { contents: Content[] }) => {
        seen.push(JSON.parse(JSON.stringify(args.contents)) as Content[])
        const calls = turns[cursor++]
        const chunk: GenerateContentResponse = calls
          ? { functionCalls: calls, candidates: [{ content: { parts: calls.map(c => ({ functionCall: c })) }, finishReason: FinishReason.STOP }] } as unknown as GenerateContentResponse
          : { text: 'Done.', candidates: [{ content: { parts: [{ text: 'Done.' }] }, finishReason: FinishReason.STOP }] } as unknown as GenerateContentResponse
        return {
          async* [Symbol.asyncIterator]() {
            yield chunk
          }
        }
      }
    }
  } as unknown as NonNullable<Parameters<typeof runAgenticLoop>[0]['ai']>
  return { ai, seen }
}

function loopOpts(ai: NonNullable<Parameters<typeof runAgenticLoop>[0]['ai']>, logger: (msg: string) => void = () => {}): Parameters<typeof runAgenticLoop>[0] {
  return {
    ai,
    model: 'fake-test-model',
    systemPrompt: 'system',
    initialPrompt: 'rewrite every section',
    aiSession: partial<Parameters<typeof runAgenticLoop>[0]['aiSession']>({ aiProviders: FULL_AI_PROVIDERS }),
    sessionId: 'sess-prune',
    abortController: new AbortController(),
    setStatus: vi.fn(),
    billingContext: {
      attributedTo: 'user:1',
      billingUserId: 1,
      plan: 'pro',
      periodStart: new Date('2026-04-01T00:00:00.000Z'),
      periodEnd: new Date('2026-05-01T00:00:00.000Z'),
      virtualKey: 'sk-fake-test-virtual-key',
      attribution: 'user'
    },
    logger,
    crossBoundary: soloSessionGuard()
  }
}

describe('runAgenticLoop: pruning old reads', () => {
  beforeEach(() => {
    executeFunctionByName.mockReset()
    executeFunctionByName.mockImplementation(async (_s, name, args) => name === 'read_section'
      ? { content: text(SECTION_CHARS, String((args as { section: string }).section.slice(2))), isError: false }
      : { content: 'Replaced the section.', isError: false })
  })

  it('stubs superseded reads in batches, never the latest two turns', async () => {
    // Turn k reads section s-k and rewrites it.
    const turns = Array.from({ length: 7 }, (_, i) => [
      call('read_section', { section: `s-${i + 1}` }),
      call('replace_section', { section: `s-${i + 1}`, markdown: 'new text' })
    ])
    const { ai, seen } = fakeAi(turns)
    const logs: string[] = []
    await runAgenticLoop(loopOpts(ai, msg => logs.push(msg)))

    const stubCount = (contents: Content[]): number => outputs(contents).filter(o => o.startsWith('[document text from turn')).length
    // Calls 1-6: the prunable total (turns older than the latest two, 12k
    // each) stays below 40k, so the history is untouched.
    expect(seen.slice(0, 6).map(stubCount)).toEqual([0, 0, 0, 0, 0, 0])
    // Call 7: turns 1-4 are prunable (48k), all four go in one batch.
    expect(stubCount(seen[6]!)).toBe(4)
    // Call 8: turn 5 alone (12k) is below the threshold again.
    expect(stubCount(seen[7]!)).toBe(4)
    const last = outputs(seen[7]!)
    expect(last[0]).toBe(prunedStub(1, true))
    // Turns 5-7 (5 is not prunable yet, 6 and 7 are the latest two) keep their text.
    expect(last.filter(o => o.length === SECTION_CHARS)).toHaveLength(3)
    expect(logs.some(l => /pruned 4 old read result\(s\)/.test(l))).toBe(true)
  })
})
