import { enqueueExportJob } from '../../repos/dataExportJobs'
import { appendAuditEvent } from '../../repos/audit'
import { AUDIT_ACCOUNT_EXPORT_REQUESTED } from '../../legal/auditActions'
import { checkRateLimit } from '../../utils/platform/rateLimit'
import { isRepoError } from '../../repos/errors'

// GDPR Article 20 — request a data export. Enqueues a job; the
// worker (`data-export-worker.ts`) runs the build + S3 PUT
// asynchronously and emails the user when ready (best-effort).
//
// Rate limit: 1 successful enqueue per user per 24 hours. The active-
// job dedup at the repo layer enforces "one in flight at a time"
// — this rate limit is the additional defense against scripted
// repeat-requests after a job completes (each one builds a new
// ZIP and consumes S3 + DB resources).
//
// 409 on concurrent active job. The UI suppresses the request
// button when an active job exists; the server enforces.

export default defineEventHandler(async (event) => {
  // Sensitive action: needs a recent sign-in (401 auth/reauth-required).
  const session = await requireRecentLogin(event)
  const userId = session.user.id

  const ip = getClientIp(event)

  if (!(await checkRateLimit('account-export-request', String(userId), 1, 24 * 60 * 60 * 1000))) {
    throw createError({
      statusCode: 429,
      message: 'You have already requested an export today. Please try again tomorrow.',
      data: { code: 'export/rate-limited' }
    })
  }

  try {
    const job = await enqueueExportJob(userId)

    await appendAuditEvent({
      actorUserId: userId,
      actorIp: ip,
      scope: 'user',
      scopeId: String(userId),
      action: AUDIT_ACCOUNT_EXPORT_REQUESTED,
      metadata: { jobId: job.jobId }
    })

    return {
      ok: true,
      jobId: job.jobId,
      status: job.status,
      createdAt: job.createdAt.toISOString()
    }
  } catch (e) {
    if (isRepoError(e)) {
      throw createError({
        statusCode: e.httpStatus,
        message: e.message,
        data: { code: 'export/conflict' }
      })
    }
    throw e
  }
})
