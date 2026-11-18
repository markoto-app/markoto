import * as Y from 'yjs'
import type { AiJobRow, AiJobUnitRow, AiJobParams, AiJobMode, AiJobStatus } from '../../../../server/repos/aiJobs'
import type { JobStore } from '../../../../server/utils/ai/jobs/jobTypes'
import { buildJobUnits, type JobTargets, type SplitOptions } from '../../../../server/utils/ai/jobs/units'
import { newUnitRows } from '../../../../server/utils/ai/jobs/runner'

// An in-memory `JobStore` over plain objects, for runner tests.

export class MemoryJobStore implements JobStore {
  job: AiJobRow
  units: AiJobUnitRow[]

  constructor(job: AiJobRow, units: AiJobUnitRow[]) {
    this.job = job
    this.units = units
  }

  async getJob() {
    return { ...this.job }
  }

  async update(patch: Partial<AiJobRow>) {
    this.job = { ...this.job, ...patch }
  }

  async transition(from: readonly AiJobStatus[], to: AiJobStatus, patch: Partial<AiJobRow> = {}) {
    if (!from.includes(this.job.status)) return false
    this.job = { ...this.job, ...patch, status: to }
    return true
  }

  async addProgress(d: { done?: number, skipped?: number, flagged?: number, retried?: number, costUsd?: number, tokensIn?: number, tokensOut?: number }) {
    const j = this.job
    this.job = {
      ...j,
      unitsDone: j.unitsDone + (d.done ?? 0),
      unitsSkipped: j.unitsSkipped + (d.skipped ?? 0),
      unitsFlagged: j.unitsFlagged + (d.flagged ?? 0),
      unitsRetried: j.unitsRetried + (d.retried ?? 0),
      costUsd: j.costUsd + (d.costUsd ?? 0),
      tokensIn: j.tokensIn + (d.tokensIn ?? 0),
      tokensOut: j.tokensOut + (d.tokensOut ?? 0)
    }
    return { ...this.job }
  }

  async claimUnits(n: number) {
    const picked = this.units.filter(u => u.status === 'pending').slice(0, n)
    for (const u of picked) u.status = 'running'
    return picked.map(u => ({ ...u }))
  }

  async updateUnit(ordinal: number, patch: Partial<AiJobUnitRow>) {
    const u = this.units.find(x => x.ordinal === ordinal)
    if (u) Object.assign(u, patch)
  }

  async listUnits(statuses?: readonly AiJobUnitRow['status'][]) {
    return this.units.filter(u => !statuses || statuses.includes(u.status)).map(u => ({ ...u }))
  }

  async requeueRunning() {
    const running = this.units.filter(u => u.status === 'running')
    for (const u of running) u.status = 'pending'
    return running.length
  }

  unit(ordinal: number): AiJobUnitRow {
    const u = this.units.find(x => x.ordinal === ordinal)
    if (!u) throw new Error(`no unit ${ordinal}`)
    return u
  }
}

export function makeJobDoc(text: string): { ydoc: Y.Doc, ytext: Y.Text } {
  const ydoc = new Y.Doc()
  const ytext = ydoc.getText('content')
  ytext.insert(0, text)
  return { ydoc, ytext }
}

export function makeJob(doc: { ydoc: Y.Doc, ytext: Y.Text }, mode: AiJobMode, params: Partial<AiJobParams> = {}, split: Partial<SplitOptions> = {}, targets: JobTargets = 'all'): MemoryJobStore {
  const units = buildJobUnits(doc.ytext.toString(), targets, { mode, ...split })
  const rows: AiJobUnitRow[] = newUnitRows(doc.ytext, units).map(u => ({
    ...u,
    jobId: 'job1',
    status: 'pending',
    reason: null,
    attempts: 0,
    afterHash: null,
    sessionAfterHash: null,
    output: null,
    costUsd: 0,
    tokensIn: 0,
    tokensOut: 0
  }))
  const now = new Date()
  const job: AiJobRow = {
    id: 'job1',
    docId: 'doc1',
    initiatorUserId: 1,
    workspaceId: null,
    sessionId: null,
    mode,
    status: 'running',
    params: { instruction: 'Do it.', ...params },
    estimate: null,
    costUsd: 0,
    costKnown: true,
    tokensIn: 0,
    tokensOut: 0,
    unitsTotal: rows.length,
    unitsDone: 0,
    unitsSkipped: 0,
    unitsFlagged: 0,
    unitsRetried: 0,
    workerModel: 'markoto-worker',
    reason: null,
    currentHeading: null,
    heartbeatAt: now,
    createdAt: now,
    updatedAt: now,
    finishedAt: null
  }
  return new MemoryJobStore(job, rows)
}

/** The `<unit>` text of a worker request. */
export function unitOf(content: string): string {
  const m = /<unit>\n([\s\S]*)\n<\/unit>/.exec(content)
  return m?.[1] ?? ''
}
