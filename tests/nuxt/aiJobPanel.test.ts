// @vitest-environment nuxt
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { nextTick } from 'vue'
import { mountSuspended, registerEndpoint, mockNuxtImport } from '@nuxt/test-utils/runtime'
import { AIJobPanel } from '#components'

// The prompt bar's panel for a delegated AI job: picks up a running job on
// mount (reload), shows done / total and the heading (never a cost), Cancel
// calls the route until every part is done; a finished job shows its
// report and "Undo job".

mockNuxtImport('useToast', () => () => ({ add: vi.fn() }))

type Job = Record<string, unknown>

function job(over: Job = {}): Job {
  return {
    jobId: 'j-abcdef123456',
    mode: 'translate',
    status: 'running',
    total: 10,
    done: 3,
    skipped: 1,
    flagged: 0,
    currentHeading: '2 Betrieb > 2.1 Teams',
    costUsd: 0.004,
    costKnown: true,
    estimateUsd: 0.01,
    estimateMinutes: 1,
    targetLanguage: 'English',
    reason: null,
    createdAt: new Date().toISOString(),
    finishedAt: null,
    ...over
  }
}

type UndoResult = { reverted: number, followUps: number, skipped: number, kept: Array<{ headingPath: string, kind: 'edited' | 'deleted' | 'expired' }> }
const UNDO_ALL: UndoResult = { reverted: 7, followUps: 0, skipped: 0, kept: [] }
const state: { list: Job[], one: Job, cancelled: number, reverted: number, undo: UndoResult } = { list: [], one: job(), cancelled: 0, reverted: 0, undo: UNDO_ALL }
registerEndpoint('/api/docs/doc-j/ai-jobs', () => ({ jobs: state.list }))
registerEndpoint('/api/docs/doc-j/ai-jobs/j-abcdef123456', () => ({ job: state.one, notes: [{ headingPath: '3 Netz', status: 'skipped', reason: 'Changed by someone else during the job; left as it was.' }] }))
registerEndpoint('/api/docs/doc-j/ai-jobs/j-abcdef123456/cancel', { method: 'POST', handler: () => {
  state.cancelled += 1
  return { job: job({ status: 'cancelled' }) }
} })
registerEndpoint('/api/docs/doc-j/ai-jobs/j-abcdef123456/revert', { method: 'POST', handler: () => {
  state.reverted += 1
  return state.undo
} })

async function flush() {
  for (let i = 0; i < 8; i++) {
    await new Promise(r => setTimeout(r, 0))
    await nextTick()
  }
}

beforeEach(() => {
  state.list = []
  state.one = job()
  state.cancelled = 0
  state.reverted = 0
  state.undo = UNDO_ALL
})

describe('AIJobPanel', () => {
  it('nothing to show without a job', async () => {
    const wrapper = await mountSuspended(AIJobPanel, { props: { docId: 'doc-j', myJobIds: [], jobOptions: { createEventSource: null, pollMs: 60_000 } } })
    await flush()
    expect(wrapper.find('[data-testid="ai-job-panel"]').exists()).toBe(false)
  })

  it('picks up a running job on mount and shows progress and heading, no cost; Cancel calls the route', async () => {
    state.list = [job()]
    const wrapper = await mountSuspended(AIJobPanel, { props: { docId: 'doc-j', myJobIds: [], jobOptions: { createEventSource: null, pollMs: 60_000 } } })
    await flush()
    const panel = wrapper.find('[data-testid="ai-job-panel"]')
    expect(panel.attributes('data-job-status')).toBe('running')
    expect(wrapper.find('[data-testid="ai-job-summary"]').text()).toBe('4 of 10 parts')
    expect(wrapper.find('[data-testid="ai-job-heading"]').text()).toContain('2.1 Teams')
    expect(wrapper.find('[data-testid="ai-job-cost"]').exists()).toBe(false)
    expect(panel.text()).not.toContain('$')
    expect(wrapper.find('[role="progressbar"]').attributes('aria-valuenow')).toBe('40')
    await wrapper.find('[data-testid="ai-job-cancel"]').trigger('click')
    await flush()
    expect(state.cancelled).toBe(1)
    expect(wrapper.find('[data-testid="ai-job-panel"]').attributes('data-job-status')).toBe('cancelled')
  })

  it('once every part is done there is no Cancel, only "finishing"', async () => {
    // Staging, 2026-11-18: Cancel clicked at 8 of 8 marked a complete job cancelled.
    state.list = [job({ done: 9, skipped: 1 })]
    const wrapper = await mountSuspended(AIJobPanel, { props: { docId: 'doc-j', myJobIds: [], jobOptions: { createEventSource: null, pollMs: 60_000 } } })
    await flush()
    expect(wrapper.find('[data-testid="ai-job-summary"]').text()).toBe('All 10 parts done, finishing…')
    expect(wrapper.find('[data-testid="ai-job-cancel"]').exists()).toBe(false)
  })

  it('a finished job shows its report and Undo job restores it', async () => {
    const finished = job({ status: 'done', done: 9, skipped: 1, finishedAt: new Date().toISOString() })
    state.list = [finished]
    state.one = finished
    const wrapper = await mountSuspended(AIJobPanel, { props: { docId: 'doc-j', myJobIds: [], jobOptions: { createEventSource: null, pollMs: 60_000 } } })
    await flush()
    expect(wrapper.find('[data-testid="ai-job-summary"]').text()).toBe('Done: 9 of 10 parts changed.')
    expect(wrapper.text()).toContain('1 parts left as they were.')
    await wrapper.find('[data-testid="ai-job-undo"]').trigger('click')
    await flush()
    expect(state.reverted).toBe(1)
    expect(wrapper.find('[data-testid="ai-job-summary"]').text()).toBe('Undone: 7 parts restored.')
    // The job's own note ("1 parts left as they were") describes the job, not the undo.
    expect(wrapper.text()).not.toContain('left as they were')
    expect(wrapper.find('[data-testid="ai-job-undo"]').exists()).toBe(false)
    await wrapper.find('[data-testid="ai-job-dismiss"]').trigger('click')
    await flush()
    expect(wrapper.find('[data-testid="ai-job-panel"]').exists()).toBe(false)
  })

  it('after Undo it names the AI session\'s corrections undone with the job and the parts kept, with why', async () => {
    const finished = job({ status: 'done', done: 8, skipped: 0, flagged: 1, total: 8, finishedAt: new Date().toISOString() })
    state.list = [finished]
    state.one = finished
    state.undo = {
      reverted: 6,
      followUps: 4,
      skipped: 2,
      kept: [{ headingPath: '3 Netz', kind: 'edited' }, { headingPath: '5 Betrieb', kind: 'edited' }]
    }
    const wrapper = await mountSuspended(AIJobPanel, { props: { docId: 'doc-j', myJobIds: [], jobOptions: { createEventSource: null, pollMs: 60_000 } } })
    await flush()
    await wrapper.find('[data-testid="ai-job-undo"]').trigger('click')
    await flush()
    const report = wrapper.find('[data-testid="ai-job-undo-report"]').text()
    expect(report).toContain('Undone: 6 parts restored.')
    expect(report).toContain('This includes markoto\'s later corrections in 4 parts.')
    expect(report).toContain('2 parts were changed after the job and stay as they are, so those changes are not lost: 3 Netz, 5 Betrieb.')
    expect(wrapper.text()).not.toContain('need a look')
  })

  it('an undo that restored nothing says so and keeps the job as it was', async () => {
    const finished = job({ status: 'done', done: 1, skipped: 0, total: 1, finishedAt: new Date().toISOString() })
    state.list = [finished]
    state.one = finished
    state.undo = { reverted: 0, followUps: 0, skipped: 1, kept: [{ headingPath: '1 Intro', kind: 'deleted' }] }
    const wrapper = await mountSuspended(AIJobPanel, { props: { docId: 'doc-j', myJobIds: [], jobOptions: { createEventSource: null, pollMs: 60_000 } } })
    await flush()
    await wrapper.find('[data-testid="ai-job-undo"]').trigger('click')
    await flush()
    expect(wrapper.find('[data-testid="ai-job-summary"]').text()).toBe('Nothing was restored.')
    expect(wrapper.text()).toContain('1 part no longer exists: 1 Intro.')
    expect(wrapper.find('[data-testid="ai-job-panel"]').attributes('data-job-status')).toBe('done')
  })
})
