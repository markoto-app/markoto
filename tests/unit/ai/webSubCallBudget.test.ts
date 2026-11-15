import { describe, it, expect, vi } from 'vitest'
import { createError } from 'h3'
import type { LoopContext } from '../../../server/utils/agentic/loop/loopContext'

// The in-app loop's web sub-call: a refused AI-budget charge reaches the
// model as a tool error that says nothing ran and asks it to tell the user
// (the next turn on a platform-paid model is refused by the same budget and
// ends the session the usual way).

const webSearch = vi.hoisted(() => vi.fn())
vi.mock('../../../server/utils/ai/tools/webSearch', () => ({ webSearch }))
vi.mock('../../../server/utils/ai/tools/fetchUrl', () => ({ fetchUrl: vi.fn() }))
vi.mock('../../../server/utils/agentic/loop/toolActivity', () => ({ logAiTool: vi.fn() }))

const { runSubCall } = await import('../../../server/utils/agentic/loop/webSubCalls')

function ctx(): LoopContext {
  return {
    opts: {
      ai: undefined,
      model: 'm',
      abortController: new AbortController(),
      aiSession: { workspaceId: null, initiatorUserId: 7, docId: 'doc-1', aiProviders: { chat: null }, docAccess: null, sessionId: 's' },
      billingContext: { virtualKey: 'sk-user-1', attributedTo: 'user:7' }
    }
  } as unknown as LoopContext
}

describe('runSubCall: budget refusal', () => {
  it('passes the caller key and attribution to the charge', async () => {
    webSearch.mockResolvedValueOnce({ text: 'answer', sources: [] })
    await runSubCall(ctx(), 'web_search', { query: 'q' })
    expect(webSearch.mock.calls[0]![4]).toMatchObject({ virtualKey: 'sk-user-1', attributedTo: 'user:7', userId: 7, docId: 'doc-1' })
  })

  it('turns a refused charge into a tool error with the user-facing text', async () => {
    webSearch.mockRejectedValueOnce(createError({ statusCode: 402, message: 'AI Points exhausted for this period.', data: { code: 'ai/budget-exhausted' } }))
    const out = await runSubCall(ctx(), 'web_search', { query: 'q' })
    expect(out.isError).toBe(true)
    expect(out.content).toBe('Error: web_search was not run. AI Points exhausted for this period. Tell the user, and continue without web tools.')
  })

  it('keeps the generic text for other failures', async () => {
    webSearch.mockRejectedValueOnce(new Error('Staan search returned 500'))
    const out = await runSubCall(ctx(), 'web_search', { query: 'q' })
    expect(out.content).toBe('Error: web_search failed: Staan search returned 500')
  })
})
