import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { runJob } from '../../../../server/utils/ai/jobs/runner'
import { revertJobUnits, REVERT_EDITED_SINCE } from '../../../../server/utils/ai/jobs/revert'
import { flushSessionFollowUps, trackSessionFollowUps, type FollowUpStore } from '../../../../server/utils/ai/jobs/followUps'
import type { JobRunnerDeps, WorkerCallResult } from '../../../../server/utils/ai/jobs/jobTypes'
import { makeJob, makeJobDoc, unitOf, type MemoryJobStore } from './memoryJobStore'

// "Undo job" after the job's own AI session corrected some parts (staging
// L12: a translation, then the planner's glossary fixes, then Undo left
// four chapters in English). Three connections to one document, as in
// production: the job's, the planner session's and a person's editor.

const DOC = [
  '# Eins',
  '',
  'Der erste Text über die Stellvertretung.',
  '',
  '# Zwei',
  '',
  'Der zweite Text über die Stellvertretung.',
  '',
  '# Drei',
  '',
  'Der dritte Text.',
  ''
].join('\n')

const SESSION_ORIGIN = 'ai:assistant:sess1'

type Handles = { ydoc: Y.Doc, ytext: Y.Text }

/** A second connection to `source`'s document, kept in sync both ways (remote transactions, like the provider's). */
function connect(source: Handles): Handles {
  const ydoc = new Y.Doc()
  Y.applyUpdate(ydoc, Y.encodeStateAsUpdate(source.ydoc), 'remote')
  const ytext = ydoc.getText('content')
  relay(source.ydoc, ydoc)
  return { ydoc, ytext }
}

/** The source acts as the sync server: every connection talks to it only. */
function relay(a: Y.Doc, b: Y.Doc): void {
  a.on('update', (u: Uint8Array, origin: unknown) => {
    if (origin !== b) Y.applyUpdate(b, u, a)
  })
  b.on('update', (u: Uint8Array, origin: unknown) => {
    if (origin !== a) Y.applyUpdate(a, u, b)
  })
}

const translate = (u: string): string => u
  .replace('erste', 'first').replace('zweite', 'second').replace('dritte', 'third')
  .replace('Eins', 'One').replace('Zwei', 'Two').replace('Drei', 'Three')
  .replace(/Der (\w+) Text über die Stellvertretung\./, 'The $1 text about the deputy arrangement.')
  .replace(/Der (\w+) Text\./, 'The $1 text.')

function deps(store: MemoryJobStore, doc: Handles): JobRunnerDeps {
  return {
    jobId: 'job1',
    store,
    doc,
    worker: async (req): Promise<WorkerCallResult> => ({ text: translate(unitOf(req.messages[1]!.content)), model: 'markoto-worker', usage: { promptTokens: 1, cachedTokens: 0, outputTokens: 1 }, costUsd: 0, latencyMs: 1 }),
    canEdit: async () => true,
    isBudgetError: () => false,
    publish: () => undefined,
    requestsPerMinute: 1e9,
    maxConcurrency: 1,
    sleep: async () => undefined
  }
}

function followUpStore(store: MemoryJobStore): FollowUpStore {
  return {
    listUnits: () => store.listUnits(['applied', 'flagged']),
    saveSessionHash: (ordinal, hash) => store.updateUnit(ordinal, { sessionAfterHash: hash })
  }
}

/** Replace `from` by `to` in `doc`, as one transaction with `origin`. */
function edit(doc: Handles, from: string, to: string, origin: unknown = null): void {
  const at = doc.ytext.toString().indexOf(from)
  if (at < 0) throw new Error(`not found: ${from}`)
  doc.ydoc.transact(() => {
    doc.ytext.delete(at, from.length)
    doc.ytext.insert(at, to)
  }, origin)
}

async function setup() {
  const jobDoc = makeJobDoc(DOC)
  const session = connect(jobDoc)
  const person = connect(jobDoc)
  const store = makeJob(jobDoc, 'translate', { targetLanguage: 'English', anchors: false }, { granularity: 'section' })
  await runJob(deps(store, jobDoc))
  expect(session.ytext.toString()).toContain('The second text about the deputy arrangement.')
  // The planner reads the job's report: from now on its edits to the parts belong to the job.
  await trackSessionFollowUps(session, SESSION_ORIGIN, 'job1', followUpStore(store))
  return { jobDoc, session, person, store }
}

describe('undo after the job session corrected its parts', () => {
  it('restores the parts the job session corrected afterwards, too', async () => {
    const { jobDoc, session, store } = await setup()
    // Glossary fix by the planner in two chapters, one transaction each.
    edit(session, 'The first text about the deputy arrangement.', 'The first text about the deputy cover.', SESSION_ORIGIN)
    edit(session, 'The second text about the deputy arrangement.', 'The second text about the deputy cover.', SESSION_ORIGIN)
    // A second correction of the same part still counts.
    edit(session, 'deputy cover', 'deputy  cover', SESSION_ORIGIN)
    await flushSessionFollowUps(session.ydoc)
    expect(store.unit(0).sessionAfterHash).not.toBeNull()
    expect(store.unit(2).sessionAfterHash).toBeNull()

    const result = await revertJobUnits({ jobId: 'job1', store, doc: jobDoc })
    expect(result).toEqual({ reverted: 3, followUps: 2, skipped: [] })
    expect(jobDoc.ytext.toString()).toBe(DOC)
    expect(session.ytext.toString()).toBe(DOC)
    expect(store.job.status).toBe('reverted')
  })

  it('keeps a part a person changed after the job and reports it, even when the session corrected it later', async () => {
    const { jobDoc, session, person, store } = await setup()
    edit(person, 'The second text', 'The 2nd text')
    edit(session, 'The 2nd text about the deputy arrangement.', 'The 2nd text about the deputy cover.', SESSION_ORIGIN)
    edit(session, 'The first text about the deputy arrangement.', 'The first text about the deputy cover.', SESSION_ORIGIN)
    await flushSessionFollowUps(session.ydoc)
    expect(store.unit(1).sessionAfterHash).toBeNull()

    const result = await revertJobUnits({ jobId: 'job1', store, doc: jobDoc })
    expect(result.reverted).toBe(2)
    expect(result.followUps).toBe(1)
    expect(result.skipped).toEqual([{ ordinal: 1, headingPath: 'Zwei', kind: 'edited', reason: REVERT_EDITED_SINCE }])
    expect(jobDoc.ytext.toString()).toContain('The 2nd text about the deputy cover.')
    expect(jobDoc.ytext.toString()).toContain('Der erste Text über die Stellvertretung.')
    expect(jobDoc.ytext.toString()).toContain('Der dritte Text.')
  })

  it('keeps a person\'s edit made after the session\'s correction', async () => {
    const { jobDoc, session, person, store } = await setup()
    edit(session, 'The second text about the deputy arrangement.', 'The second text about the deputy cover.', SESSION_ORIGIN)
    edit(person, 'deputy cover', 'deputy cover (see 8.2)')
    await flushSessionFollowUps(session.ydoc)
    const result = await revertJobUnits({ jobId: 'job1', store, doc: jobDoc })
    expect(result.reverted).toBe(2)
    expect(result.skipped.map(s => s.kind)).toEqual(['edited'])
    expect(jobDoc.ytext.toString()).toContain('deputy cover (see 8.2)')
  })

  it('does not count edits of another origin on the session connection', async () => {
    const { jobDoc, session, store } = await setup()
    edit(session, 'The second text about the deputy arrangement.', 'The second text about the deputy cover.', 'ai:assistant:other')
    await flushSessionFollowUps(session.ydoc)
    expect(store.unit(1).sessionAfterHash).toBeNull()
    const result = await revertJobUnits({ jobId: 'job1', store, doc: jobDoc })
    expect(result.reverted).toBe(2)
    expect(result.skipped.map(s => s.ordinal)).toEqual([1])
  })
})
