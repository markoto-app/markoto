import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { JobRunner, runJob, REASON_CHANGED, REASON_BUDGET, REASON_ACCESS, jobOrigin, composeUnitText } from '../../../../server/utils/ai/jobs/runner'
import { revertJobUnits, REVERT_EDITED_SINCE } from '../../../../server/utils/ai/jobs/revert'
import type { JobProgress, JobRunnerDeps, WorkerCallRequest, WorkerCallResult } from '../../../../server/utils/ai/jobs/jobTypes'
import { makeJob, makeJobDoc, unitOf, type MemoryJobStore } from './memoryJobStore'

const DOC = [
  '# Eins',
  '',
  'Der erste Text mit `code` und einem [Link](https://example.com).',
  '',
  '# Zwei',
  '',
  'Der zweite Text.',
  '',
  '# Drei',
  '',
  'Der dritte Text.',
  ''
].join('\n')

class BudgetError extends Error {}

type Transform = (unit: string, req: WorkerCallRequest) => string | Promise<string>

function worker(transform: Transform, calls: WorkerCallRequest[] = []): JobRunnerDeps['worker'] {
  return async (req): Promise<WorkerCallResult> => {
    calls.push(req)
    const text = await transform(unitOf(req.messages[1]!.content), req)
    return { text, model: 'markoto-worker', usage: { promptTokens: 100, cachedTokens: 0, outputTokens: 50 }, costUsd: 0.001, latencyMs: 5 }
  }
}

function deps(store: MemoryJobStore, doc: { ydoc: Y.Doc, ytext: Y.Text }, w: JobRunnerDeps['worker'], extra: Partial<JobRunnerDeps> = {}): JobRunnerDeps & { progress: JobProgress[] } {
  const progress: JobProgress[] = []
  return {
    jobId: 'job1',
    store,
    doc,
    worker: w,
    canEdit: async () => true,
    isBudgetError: e => e instanceof BudgetError,
    publish: p => progress.push(p),
    requestsPerMinute: 1e9,
    maxConcurrency: 1,
    sleep: async () => undefined,
    progress,
    ...extra
  }
}

const upper = (u: string): string => u.replace(/Text/g, 'TEXT')

describe('job runner', () => {
  it('applies every unit, keeps masked parts, publishes progress and sums cost', async () => {
    const doc = makeJobDoc(DOC)
    const store = makeJob(doc, 'rewrite', {}, { granularity: 'section' })
    const origins: unknown[] = []
    doc.ydoc.on('afterTransaction', (tr: Y.Transaction) => origins.push(tr.origin))
    const d = deps(store, doc, worker(upper))
    const result = await runJob(d)
    expect(result).toEqual({ status: 'done', done: 3, skipped: 0, flagged: 0 })
    expect(doc.ytext.toString()).toBe(DOC.replace(/Text/g, 'TEXT'))
    expect(store.units.every(u => u.status === 'applied' && u.afterHash !== null)).toBe(true)
    expect(store.job.costUsd).toBeCloseTo(0.003, 6)
    expect(store.job.finishedAt).not.toBeNull()
    expect(origins).toEqual([jobOrigin('job1'), jobOrigin('job1'), jobOrigin('job1')])
    expect(d.progress.at(-1)).toMatchObject({ jobId: 'job1', status: 'done', done: 3, total: 3 })
  })

  it('skips a unit changed before or during the job, without touching the edit', async () => {
    const doc = makeJobDoc(DOC)
    const store = makeJob(doc, 'rewrite', {}, { granularity: 'section' })
    // Before the run: someone edits unit 2.
    doc.ytext.insert(DOC.indexOf('zweite'), 'neue ')
    // During the call for unit 3: someone edits it.
    const d = deps(store, doc, worker((u) => {
      if (u.includes('dritte')) doc.ytext.insert(doc.ytext.toString().indexOf('dritte'), 'sehr ')
      return upper(u)
    }))
    const result = await runJob(d)
    expect(result.status).toBe('done')
    expect(store.unit(1)).toMatchObject({ status: 'skipped', reason: REASON_CHANGED })
    expect(store.unit(2)).toMatchObject({ status: 'skipped', reason: REASON_CHANGED })
    expect(doc.ytext.toString()).toContain('Der neue zweite Text.')
    expect(doc.ytext.toString()).toContain('Der sehr dritte Text.')
    expect(doc.ytext.toString()).toContain('Der erste TEXT')
  })

  it('cancel mid-run: discards the in-flight result and leaves the rest pending', async () => {
    const doc = makeJobDoc(DOC)
    const store = makeJob(doc, 'rewrite', {}, { granularity: 'section' })
    const d = deps(store, doc, worker((u) => {
      if (u.includes('zweite')) store.job = { ...store.job, status: 'cancelled' }
      return upper(u)
    }))
    const result = await runJob(d)
    expect(result.status).toBe('cancelled')
    expect(store.units.map(u => u.status)).toEqual(['applied', 'pending', 'pending'])
    expect(doc.ytext.toString()).toContain('Der zweite Text.')
  })

  it('resumes after a restart on a fresh connection', async () => {
    const doc = makeJobDoc(DOC)
    const store = makeJob(doc, 'rewrite', {}, { granularity: 'section' })
    const shutdown = new AbortController()
    await runJob(deps(store, doc, worker((u) => {
      if (u.includes('zweite')) shutdown.abort()
      return upper(u)
    }), { signal: shutdown.signal }))
    expect(store.job.status).toBe('interrupted')
    expect(store.units.map(u => u.status)).toEqual(['applied', 'pending', 'pending'])

    // A new process: a new Y.Doc synced from the stored state.
    const fresh = new Y.Doc()
    Y.applyUpdate(fresh, Y.encodeStateAsUpdate(doc.ydoc))
    const freshDoc = { ydoc: fresh, ytext: fresh.getText('content') }
    store.job = { ...store.job, status: 'running' }
    const result = await runJob(deps(store, freshDoc, worker(upper)))
    expect(result).toMatchObject({ status: 'done', done: 3 })
    expect(freshDoc.ytext.toString()).toBe(DOC.replace(/Text/g, 'TEXT'))
  })

  it('pauses on a budget refusal and keeps the unit pending', async () => {
    const doc = makeJobDoc(DOC)
    const store = makeJob(doc, 'rewrite', {}, { granularity: 'section' })
    const result = await runJob(deps(store, doc, worker((u) => {
      if (u.includes('zweite')) throw new BudgetError('budget exceeded')
      return upper(u)
    })))
    expect(result.status).toBe('paused_budget')
    expect(store.job.reason).toBe(REASON_BUDGET)
    expect(store.units.map(u => u.status)).toEqual(['applied', 'pending', 'pending'])
  })

  it('stops when the initiator lost the edit right', async () => {
    const doc = makeJobDoc(DOC)
    const store = makeJob(doc, 'rewrite', {}, { granularity: 'section' })
    let allowed = 1
    const result = await runJob(deps(store, doc, worker(upper), { canEdit: async () => allowed-- > 0 }))
    expect(result.status).toBe('stopped_access')
    expect(store.job.reason).toBe(REASON_ACCESS)
    expect(store.units.map(u => u.status)).toEqual(['applied', 'pending', 'pending'])
  })

  it('fixes em-dashes in a worker answer instead of retrying, and notes it on the unit', async () => {
    const doc = makeJobDoc(DOC)
    const store = makeJob(doc, 'rewrite', {}, { granularity: 'section' }, { sections: [1] })
    const calls: WorkerCallRequest[] = []
    const result = await runJob(deps(store, doc, worker(u => u.replace('Der zweite Text.', 'Der zweite Text \u2014 neu.'), calls)))
    expect(result.status).toBe('done')
    expect(calls).toHaveLength(1)
    expect(doc.ytext.toString()).toContain('Der zweite Text, neu.')
    expect(store.unit(0)).toMatchObject({ status: 'applied', attempts: 1 })
    expect(store.unit(0).reason).toMatch(/1 em-dash the AI wrote was replaced automatically/)
  })

  it('retry ladder: feedback, then escalation, then skip', async () => {
    const doc = makeJobDoc(DOC)
    const store = makeJob(doc, 'rewrite', {}, { granularity: 'section' }, { sections: [0] })
    const calls: WorkerCallRequest[] = []
    // Unit 1 has a placeholder (code + link): drop them until escalated.
    const result = await runJob(deps(store, doc, worker((u, req) => (req.escalated ? upper(u) : u.replace(/⟦P\d+⟧/g, '')), calls)))
    expect(result.status).toBe('done')
    expect(calls.map(c => c.escalated)).toEqual([false, false, true])
    expect(calls[1]!.messages[1]!.content).toContain('Your previous answer for this unit was rejected:\n- Placeholder ⟦P1⟧ is missing.')
    expect(store.unit(0)).toMatchObject({ status: 'applied', attempts: 3 })
    expect(store.job.unitsRetried).toBe(2)
    expect(doc.ytext.toString()).toContain('Der erste TEXT mit `code` und einem [Link](https://example.com).')

    const doc2 = makeJobDoc(DOC)
    const store2 = makeJob(doc2, 'rewrite', {}, { granularity: 'section' }, { sections: [1] })
    const r2 = await runJob(deps(store2, doc2, worker(() => 'Sure! Here is the text.')))
    expect(r2.status).toBe('done')
    expect(store2.unit(0).status).toBe('skipped')
    expect(store2.unit(0).reason).toMatch(/failed the checks 3 times/)
    expect(doc2.ytext.toString()).toBe(DOC)
  })

  it('undo restores units still as the job wrote them and skips later edits', async () => {
    const doc = makeJobDoc(DOC)
    const store = makeJob(doc, 'rewrite', {}, { granularity: 'section' })
    await runJob(deps(store, doc, worker(upper)))
    const second = doc.ytext.toString().indexOf('zweite')
    doc.ytext.insert(second, 'liebe ')
    const result = await revertJobUnits({ jobId: 'job1', store, doc })
    expect(result.reverted).toBe(2)
    expect(result.skipped).toEqual([{ ordinal: 1, headingPath: 'Zwei', kind: 'edited', reason: REVERT_EDITED_SINCE }])
    expect(doc.ytext.toString()).toBe(DOC.replace('Der zweite Text.', 'Der liebe zweite TEXT.'))
    expect(store.job.status).toBe('reverted')
    expect(store.units.map(u => u.status)).toEqual(['reverted', 'applied', 'reverted'])
  })

  it('comment mode stores findings with unmasked quotes and changes no text', async () => {
    const doc = makeJobDoc(DOC)
    const store = makeJob(doc, 'comment', {}, { granularity: 'section' }, { sections: [0] })
    await runJob(deps(store, doc, worker(u => JSON.stringify([{ quote: u.match(/mit ⟦P\d+⟧/)![0], issue: 'Unklar.', severity: 'medium' }]))))
    expect(doc.ytext.toString()).toBe(DOC)
    expect(store.unit(0).output).toEqual({ kind: 'comments', findings: [{ quote: 'mit `code`', issue: 'Unklar.', severity: 'medium' }] })
  })

  it('translate pins the old heading anchors and flags glossary misses', async () => {
    const doc = makeJobDoc(DOC)
    const store = makeJob(doc, 'translate', { targetLanguage: 'English', glossary: [{ source: 'Drei', target: 'Three' }] }, { granularity: 'section' })
    await runJob(deps(store, doc, worker(u => u.replace('# Eins', '# One').replace('# Zwei', '# Two').replace('# Drei', '# Tres'))))
    const text = doc.ytext.toString()
    expect(text).toContain('# One {#eins}')
    expect(text).toContain('# Two {#zwei}')
    expect(store.unit(2)).toMatchObject({ status: 'flagged' })
    expect(store.job.unitsFlagged).toBe(1)
  })

  it('preview runs the worker on chosen units without applying anything', async () => {
    const doc = makeJobDoc(DOC)
    const store = makeJob(doc, 'rewrite', {}, { granularity: 'section' })
    store.job = { ...store.job, status: 'preview' }
    const samples = await new JobRunner(deps(store, doc, worker(upper))).preview([0, 2])
    expect(samples.map(s => [s.ordinal, s.ok])).toEqual([[0, true], [2, true]])
    expect(samples[0]!.after).toContain('Der erste TEXT mit `code`')
    expect(doc.ytext.toString()).toBe(DOC)
    expect(store.units.map(u => u.status)).toEqual(['pending', 'pending', 'pending'])
    expect(store.unit(2).output).toMatchObject({ kind: 'preview', problems: [] })
    // A running job is never previewed.
    store.job = { ...store.job, status: 'running' }
    expect(await new JobRunner(deps(store, doc, worker(upper))).preview([0])).toEqual([])
  })

  it('summary placement inserts below the heading', () => {
    const job = { mode: 'summarise' as const, params: { instruction: 'x' } }
    expect(composeUnitText(job, '# Kapitel\n\nText.\n\n', '*Kurz.*')).toBe('# Kapitel\n\n*Kurz.*\n\nText.\n\n')
    expect(composeUnitText({ ...job, params: { instruction: 'x', placement: 'insert_at_end' } }, '# K\n\nText.\n', 'S.')).toBe('# K\n\nText.\n\nS.\n')
  })
})
