import type { AiJobStatus } from '../../../repos/aiJobs'
import { getJobProgress } from './engine'

// The job statuses an AI session last saw, so its answer cannot describe a
// job state that no longer exists. On staging the planner announced
// "Chapters 2 to 9 are translated" after the user had clicked "Undo job"
// in the job panel. `delegate_rewrite` records every status it reports to
// the model; before `message_to_user` delivers, the current statuses are
// compared and a job the user cancelled or undid in the meantime is
// reported back to the model instead. Kept per session object (the loop's
// AiSession), so it ends with the session.

const seen = new WeakMap<object, Map<string, AiJobStatus>>()

/** Statuses the user can move a job to from the job panel. */
const USER_STATES: ReadonlySet<AiJobStatus> = new Set(['cancelled', 'reverted'])

/** Remember that the session's model was told `jobId` is `status`. */
export function noteJobSeen(session: object, jobId: string, status: AiJobStatus): void {
  let jobs = seen.get(session)
  if (!jobs) {
    jobs = new Map()
    seen.set(session, jobs)
  }
  jobs.set(jobId, status)
}

export interface ChangedJob {
  jobId: string
  seen: AiJobStatus
  now: AiJobStatus
  done: number
  total: number
}

/**
 * Jobs of this session the user cancelled or undid after the model last
 * saw them. Each change is reported once: the seen status is updated.
 */
export async function jobsChangedByUser(session: object): Promise<ChangedJob[]> {
  const jobs = seen.get(session)
  if (!jobs || jobs.size === 0) return []
  const out: ChangedJob[] = []
  for (const [jobId, was] of jobs) {
    const p = await getJobProgress(jobId).catch(() => null)
    if (!p || p.status === was || !USER_STATES.has(p.status)) continue
    jobs.set(jobId, p.status)
    out.push({ jobId, seen: was, now: p.status, done: p.done, total: p.total })
  }
  return out
}

/** The tool error that tells the model about the changes. */
export function changedJobsNote(changed: readonly ChangedJob[]): string {
  const lines = changed.map(c => c.now === 'reverted'
    ? `job ${c.jobId}: the user clicked Undo; the job's changes are removed and those parts read as before the job`
    : `job ${c.jobId}: the user cancelled it (${c.done} of ${c.total} parts were changed and stay changed)`)
  return `Not shown: the document changed after you last checked. ${lines.join('; ')}. Write your message for the document as it is now (for example "The translation was undone; the chapters are German again.").`
}
