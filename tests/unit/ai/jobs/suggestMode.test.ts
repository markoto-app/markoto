import { describe, expect, it } from 'vitest'
import type * as Y from 'yjs'
import { runJob } from '../../../../server/utils/ai/jobs/runner'
import { revertJobUnits } from '../../../../server/utils/ai/jobs/revert'
import type { JobRunnerDeps, WorkerCallResult } from '../../../../server/utils/ai/jobs/jobTypes'
import { readSuggestions, applySuggestion, suggestionsMap } from '../../../../shared/utils/suggestions/ySuggestions'
import { SUGGESTIONS_PER_DOC_MAX } from '../../../../shared/utils/suggestions/record'
import { makeJob, makeJobDoc, unitOf, type MemoryJobStore } from './memoryJobStore'

// A delegated job with `suggest: true` writes suggestions instead of text.
// Undoing it removes the open ones and, for those a person accepted, puts
// the old text back.

const DOC = ['# Eins', '', 'Der erste Text.', '', '# Zwei', '', 'Der zweite Text.', ''].join('\n')

const worker: JobRunnerDeps['worker'] = async (req): Promise<WorkerCallResult> => ({
  text: unitOf(req.messages[1]!.content).replace(/Text/g, 'TEXT'),
  model: 'm', usage: { promptTokens: 1, cachedTokens: 0, outputTokens: 1 }, costUsd: 0, latencyMs: 1
})

function deps(store: MemoryJobStore, doc: { ydoc: Y.Doc, ytext: Y.Text }): JobRunnerDeps {
  return { jobId: 'job1', store, doc, worker, canEdit: async () => true, isBudgetError: () => false, publish: () => {}, requestsPerMinute: 1e9, maxConcurrency: 1, sleep: async () => undefined }
}

function suggestJob() {
  const doc = makeJobDoc(DOC)
  const store = makeJob(doc, 'rewrite', { suggest: true }, { granularity: 'section' })
  return { doc, store }
}

describe('job in suggestion mode', () => {
  it('leaves the text alone and records one group of suggestions per unit, as the job', async () => {
    const { doc, store } = suggestJob()
    const result = await runJob(deps(store, doc))
    expect(result).toMatchObject({ status: 'done', done: 2, skipped: 0 })
    expect(doc.ytext.toString()).toBe(DOC)
    const all = readSuggestions(doc.ydoc)
    expect(all).toHaveLength(2)
    expect(all.every(s => s.record.jobId === 'job1' && s.record.authorPrincipal === 'ai-job:job1')).toBe(true)
    expect(all.map(s => s.record.groupId)).toEqual(['job:job1:0', 'job:job1:1'])
    expect(all.map(s => s.record.text)).toEqual(['TEXT', 'TEXT'])
    expect(store.units.every(u => u.status === 'applied' && u.afterHash !== null)).toBe(true)
  })

  it('skips a unit with the limit message when the document holds too many suggestions', async () => {
    const { doc, store } = suggestJob()
    const map = suggestionsMap(doc.ydoc)
    for (let i = 0; i < SUGGESTIONS_PER_DOC_MAX; i++) map.set(`filler-${i}`, { filler: true })
    const result = await runJob(deps(store, doc))
    expect(result.skipped).toBe(2)
    expect(store.unit(0)).toMatchObject({ status: 'skipped' })
    expect(store.unit(0).reason).toContain(String(SUGGESTIONS_PER_DOC_MAX))
  })

  it('undo removes the open suggestions of the job and counts them as parts restored', async () => {
    const { doc, store } = suggestJob()
    await runJob(deps(store, doc))
    const other = { v: 1 }
    suggestionsMap(doc.ydoc).set('foreign-1', other)
    const result = await revertJobUnits({ jobId: 'job1', store, doc })
    expect(readSuggestions(doc.ydoc)).toHaveLength(0)
    expect(suggestionsMap(doc.ydoc).has('foreign-1')).toBe(true)
    expect(result).toMatchObject({ reverted: 2, skipped: [] })
    expect(doc.ytext.toString()).toBe(DOC)
  })

  it('undo puts back the text of a suggestion a person accepted, and drops only the rest', async () => {
    const { doc, store } = suggestJob()
    await runJob(deps(store, doc))
    const first = readSuggestions(doc.ydoc)[0]!
    doc.ydoc.transact(() => {
      applySuggestion(doc.ydoc, first.record)
    })
    expect(doc.ytext.toString()).toContain('Der erste TEXT.')
    const result = await revertJobUnits({ jobId: 'job1', store, doc })
    expect(doc.ytext.toString()).toBe(DOC)
    expect(readSuggestions(doc.ydoc)).toHaveLength(0)
    expect(result.reverted).toBe(2)
  })
})
