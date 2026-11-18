import type { AiJobRow } from '../../../repos/aiJobs'
import type { JobUnitNote } from './engine'
import type { JobProgress } from './jobTypes'

// What the job routes return about a delegated AI job (prompt bar progress,
// finished report). Counts, cost, the heading being worked on and reasons;
// never the instruction, the glossary or unit texts.

const RUNNING_STATUSES: ReadonlySet<AiJobRow['status']> = new Set(['preview', 'awaiting_confirmation', 'running'])

/** Whether the job can still change (the progress stream keeps going). */
export function isJobActive(status: AiJobRow['status']): boolean {
  return RUNNING_STATUSES.has(status)
}

export function toJobView(row: AiJobRow) {
  return {
    jobId: row.id,
    mode: row.mode,
    status: row.status,
    total: row.unitsTotal,
    done: row.unitsDone,
    skipped: row.unitsSkipped,
    flagged: row.unitsFlagged,
    currentHeading: row.currentHeading,
    costUsd: Math.round(row.costUsd * 10_000) / 10_000,
    costKnown: row.costKnown,
    estimateUsd: row.costKnown ? (row.estimate?.usd ?? null) : null,
    estimateMinutes: row.estimate?.minutes ?? null,
    targetLanguage: row.params.targetLanguage ?? null,
    reason: row.reason,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null
  }
}

export type JobView = ReturnType<typeof toJobView>

/** A progress event applied to a view the client already has (same fields). */
export function progressPatch(p: JobProgress) {
  return {
    jobId: p.jobId,
    status: p.status,
    total: p.total,
    done: p.done,
    skipped: p.skipped,
    flagged: p.flagged,
    currentHeading: p.currentHeading,
    costUsd: p.costUsd,
    costKnown: p.costKnown
  }
}

export function toJobNotes(notes: readonly JobUnitNote[]) {
  return notes.map(n => ({ headingPath: n.headingPath, status: n.status, reason: n.reason }))
}
