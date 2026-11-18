import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as Y from 'yjs'
import type { LoopContext } from '../../../server/utils/agentic/loop/loopContext'

// Answers must describe the document as it is, not as the model meant it to
// be. Two staging cases of 2026-11-18 (doc YacFgf1tHR):
//   - the closing turn at the step limit said the headings read
//     "10, 12, 12, 13, 14" when chapters 10 to 12 all read 12;
//   - the planner announced "Chapters 2 to 9 are translated" after the user
//     had clicked "Undo job".

const getJobProgress = vi.hoisted(() => vi.fn())
vi.mock('../../../server/utils/ai/jobs/engine', () => ({ getJobProgress }))
const appendAiMessage = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('../../../server/repos/aiSessionMessages', () => ({ appendAiMessage }))

const { executeFunctionByName } = await import('../../../server/utils/ai/tools/registry')
const { noteJobSeen } = await import('../../../server/utils/ai/jobs/sessionJobs')
const { currentHeadingsNote } = await import('../../../server/utils/agentic/loop/wrapUp')

function session(deliverResponse = vi.fn()) {
  const ydoc = new Y.Doc()
  return { ydoc, ytext: ydoc.getText('content'), ymeta: ydoc.getMap('meta'), sessionId: 's1', initiatorUserId: 1, docAccess: {}, updateStatus: vi.fn(), deliverResponse }
}

function progress(status: string) {
  return { jobId: 'j-1', status, done: 8, skipped: 0, flagged: 0, total: 8, currentHeading: null, costUsd: 0, costKnown: true }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('message_to_user after the user changed a job', () => {
  it('is refused once when the job was undone since the model saw it, then delivered', async () => {
    const deliver = vi.fn()
    const ctx = session(deliver)
    noteJobSeen(ctx, 'j-1', 'done')
    getJobProgress.mockResolvedValue(progress('reverted'))
    const args = { message: 'Chapters 2 to 9 are translated into English.' }
    const first = await executeFunctionByName(ctx as never, 'message_to_user', args)
    expect(first.isError).toBe(true)
    expect(first.content).toMatch(/the user clicked Undo/)
    expect(deliver).not.toHaveBeenCalled()

    const second = await executeFunctionByName(ctx as never, 'message_to_user', { message: 'The translation was undone; the chapters are German again.' })
    expect(second.isError).toBe(false)
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ message: 'The translation was undone; the chapters are German again.' }))
  })

  it('is delivered when the job is as the model last saw it', async () => {
    const deliver = vi.fn()
    const ctx = session(deliver)
    noteJobSeen(ctx, 'j-1', 'done')
    getJobProgress.mockResolvedValue(progress('done'))
    const res = await executeFunctionByName(ctx as never, 'message_to_user', { message: 'Done: 8 of 8 parts.' })
    expect(res.isError).toBe(false)
    expect(deliver).toHaveBeenCalledTimes(1)
  })

  it('needs no lookup in a session without jobs', async () => {
    const res = await executeFunctionByName(session() as never, 'message_to_user', { message: 'Hello.' })
    expect(res.isError).toBe(false)
    expect(getJobProgress).not.toHaveBeenCalled()
  })
})

describe('closing turn: the headings as they read now', () => {
  function loopCtx(text: string, editedDocument: boolean): LoopContext {
    const ydoc = new Y.Doc()
    ydoc.getText('content').insert(0, text)
    return { editedDocument, opts: { aiSession: { ytext: ydoc.getText('content') } } } as unknown as LoopContext
  }

  it('lists the current headings (up to level 2) after an edit', () => {
    const note = currentHeadingsNote(loopCtx('# 12 Notfall\n\n## 12.1 Stufen\n\n### 12.1.1 Risiken\n\n# 12 Lieferanten\n\n# 12 Service\n', true))
    expect(note).toContain('as they read right now')
    expect(note).toContain('# 12 Notfall\n## 12.1 Stufen\n# 12 Lieferanten\n# 12 Service')
    expect(note).not.toContain('12.1.1')
  })

  it('is empty when the session did not edit', () => {
    expect(currentHeadingsNote(loopCtx('# A\n', false))).toBe('')
  })
})
