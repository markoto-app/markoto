import { listJobsForUser } from '../../repos/dataExportJobs'

// History list — drives /settings/profile/exports. Returns the user's
// recent export jobs in reverse-chronological order. Excludes any
// raw S3 keys; the download endpoint mints presigned URLs separately.

export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const jobs = await listJobsForUser(session.user.id)

  return jobs.map(j => ({
    jobId: j.jobId,
    status: j.status,
    sizeBytes: j.sizeBytes,
    errorMessage: j.errorMessage,
    expiresAt: j.expiresAt?.toISOString() ?? null,
    createdAt: j.createdAt.toISOString(),
    startedAt: j.startedAt?.toISOString() ?? null,
    completedAt: j.completedAt?.toISOString() ?? null,
    // Convenience flag for the UI — gates the "Download" button.
    downloadable: j.status === 'ready'
      && j.s3Key !== null
      && j.expiresAt !== null
      && j.expiresAt > new Date()
  }))
})
