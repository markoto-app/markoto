// @vitest-environment nuxt
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { nextTick } from 'vue'
import { mountSuspended, registerEndpoint, mockNuxtImport } from '@nuxt/test-utils/runtime'
import { AIJobPanel } from '#components'

// The prompt bar's panel for a delegated AI job: picks up a running job on
// mount (reload), shows done / total, the heading and the cost, Cancel
// calls the route; a finished job shows its report and "Undo job".

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

const state: { list: Job[], one: Job, cancelled: number, reverted: number } = { list: [], one: job(), cancelled: 0, reverted: 0 }
registerEndpoint('/api/docs/doc-j/ai-jobs', () => ({ jobs: state.list }))
registerEndpoint('/api/docs/doc-j/ai-jobs/j-abcdef123456', () => ({ job: state.one, notes: [{ headingPath: '3 Netz', status: 'skipped', reason: 'Changed by someone else during the job; left as it was.' }] }))
registerEndpoint('/api/docs/doc-j/ai-jobs/j-abcdef123456/cancel', { method: 'POST', handler: () => {
  state.cancelled += 1
  return { job: job({ status: 'cancelled' }) }
} })
registerEndpoint('/api/docs/doc-j/ai-jobs/j-abcdef123456/revert', { method: 'POST', handler: () => {
  state.reverted += 1
  return { reverted: 7, skipped: 1 }
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
})

describe('AIJobPanel', () => {
  it('nothing to show without a job', async () => {
    const wrapper = await mountSuspended(AIJobPanel, { props: { docId: 'doc-j', myJobIds: [], jobOptions: { createEventSource: null, pollMs: 60_000 } } })
    await flush()
    expect(wrapper.find('[data-testid="ai-job-panel"]').exists()).toBe(false)
  })

  it('picks up a running job on mount and shows progress, heading and cost; Cancel calls the route', async () => {
    state.list = [job()]
    const wrapper = await mountSuspended(AIJobPanel, { props: { docId: 'doc-j', myJobIds: [], jobOptions: { createEventSource: null, pollMs: 60_000 } } })
    await flush()
    const panel = wrapper.find('[data-testid="ai-job-panel"]')
    expect(panel.attributes('data-job-status')).toBe('running')
    expect(wrapper.find('[data-testid="ai-job-summary"]').text()).toBe('4 of 10 parts')
    expect(wrapper.find('[data-testid="ai-job-heading"]').text()).toContain('2.1 Teams')
    expect(wrapper.find('[data-testid="ai-job-cost"]').text()).toBe('Cost so far: $0.004')
    expect(wrapper.find('[role="progressbar"]').attributes('aria-valuenow')).toBe('40')
    await wrapper.find('[data-testid="ai-job-cancel"]').trigger('click')
    await flush()
    expect(state.cancelled).toBe(1)
    expect(wrapper.find('[data-testid="ai-job-panel"]').attributes('data-job-status')).toBe('cancelled')
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
    await wrapper.find('[data-testid="ai-job-dismiss"]').trigger('click')
    await flush()
    expect(wrapper.find('[data-testid="ai-job-panel"]').exists()).toBe(false)
  })
})
