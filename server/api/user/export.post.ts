import { enqueueExportJob } from '../../repos/dataExportJobs'
import { appendAuditEvent } from '../../repos/audit'
import { AUDIT_ACCOUNT_EXPORT_REQUESTED } from '../../legal/auditActions'
import { isRepoError } from '../../repos/errors'
import { DAY_MS } from '~~/shared/config/units'

// GDPR Article 20: request a data export. Enqueues a job; the
// worker (`data-export-worker.ts`) runs the build + S3 PUT
// asynchronously and emails the user when ready (best-effort).
//
// Rate limit: 1 successful enqueue per user per 24 hours. The active-
// job dedup at the repo layer enforces "one in flight at a time"
// this rate limit is the additional defense against scripted
// repeat-requests after a job completes (each one builds a new
// ZIP and consumes S3 + DB resources).
//
// 409 on concurrent active job. The UI suppresses the request
// button when an active job exists; the server enforces.

export default defineApiHandler({
  access: allow.user(),
  // Sensitive action: needs a recent sign-in (401 auth/reauth-required).
  recentLogin: true,
  body: 'none',
  rateLimit: { namespace: 'account-export-request', max: 1, windowMs: DAY_MS, key: 'user', error: 'export/rate-limited' },
  handler: async ({ event, user, self }) => {
    const userId = user.id

    const ip = getClientIp(event)

    try {
      const job = await enqueueExportJob(self)

      await appendAuditEvent({
        by: self,
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
        // A missing row is not "already in progress": each case keeps its own text.
        throw e.httpStatus === 404 ? apiError('export/not-found', undefined, { cause: e }) : apiError('export/conflict', undefined, { cause: e })
      }
      throw e
    }
  }
})
