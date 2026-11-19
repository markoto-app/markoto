import type { ImportJobRow } from '../../repos/imports'

/** What a client sees of an import job (no user id, no storage keys). */
export function importJobView(job: ImportJobRow) {
  return {
    jobId: job.jobId,
    workspaceId: job.workspaceId,
    targetFolderId: job.targetFolderId,
    source: job.source,
    sourceRef: job.sourceRef,
    status: job.status,
    cancelRequested: job.cancelRequested,
    total: job.total,
    done: job.done,
    failed: job.failed,
    skipped: job.skipped,
    error: job.error,
    createdAt: job.createdAt.toISOString(),
    finishedAt: job.finishedAt?.toISOString() ?? null
  }
}
