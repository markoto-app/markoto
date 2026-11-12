import * as Sentry from '@sentry/nuxt'
import { PutObjectCommand } from '@aws-sdk/client-s3'
import {
  claimQueuedJob,
  markJobFailed,
  markJobReady
} from '../../repos/dataExportJobs'
import { findUserById } from '../../repos/users'
import { appendAuditEvent } from '../../repos/audit'
import {
  AUDIT_ACCOUNT_EXPORT_COMPLETED,
  AUDIT_ACCOUNT_EXPORT_FAILED
} from '../../legal/auditActions'
import { useS3Client } from '../storage/s3'
import { buildExportZip } from './dataExport'
import { safeSendTransactionalEmail } from '../email/sendEmail'
import { DATA_EXPORT_RETENTION_DAYS } from '~~/shared/config/retention'
import { useEnv } from '~~/shared/env/load'
import { useLogger } from '../platform/logger'

const log = useLogger('data-export')

// Worker that drives queued data-export jobs to completion. Picks up
// the oldest queued row, builds the ZIP via `buildExportZip`,
// uploads to S3, marks the row `ready`. On failure marks `failed`
// with the error message and audits.
//
// **One job per tick.** Even though `claimQueuedJob` uses
// `SELECT … FOR UPDATE SKIP LOCKED` (so multiple workers don't
// fight over the same row), processing one at a time keeps the
// worker deterministic for testing and avoids stacking memory
// pressure when several large exports queue up. The plugin runs
// the worker every minute, so a queue of 60 jobs drains in an
// hour worst-case.
//
// **Retention:** 7 days. Set on `expires_at` at ready-time. The
// expiry sweeper (data-export-expiry-sweep) flips ready → expired
// + deletes the S3 blob.

const S3_KEY_PREFIX = 'exports'

export interface RunDataExportWorkerResult {
  // Did we attempt a job? `null` means the queue was empty.
  jobId: string | null
  // Did the attempted job succeed?
  succeeded: boolean
  // The S3 key written, on success.
  s3Key: string | null
  // The error message, on failure (truncated as stored).
  errorMessage: string | null
}

/**
 * Run one tick of the worker. Returns null fields when the queue
 * was empty. Per-job try/catch isolates failures — the worker
 * always marks the row + appends the audit event before returning.
 *
 * Caller (the plugin) is responsible for the cross-instance
 * advisory lock — keeps two workers from racing on the same job.
 * Even with the SKIP LOCKED claim, taking the lock means one
 * worker per tick and no double-S3-PUT.
 */
export async function runDataExportWorker(): Promise<RunDataExportWorkerResult> {
  const job = await claimQueuedJob()
  if (!job) {
    return { jobId: null, succeeded: false, s3Key: null, errorMessage: null }
  }

  const result: RunDataExportWorkerResult = {
    jobId: job.jobId,
    succeeded: false,
    s3Key: null,
    errorMessage: null
  }

  try {
    const { bytes, counts } = await buildExportZip(job.userId)
    const s3Key = `${S3_KEY_PREFIX}/${job.userId}/${job.jobId}.zip`

    const env = useEnv()
    const s3 = useS3Client()
    await s3.send(new PutObjectCommand({
      Bucket: env.storage.bucket,
      Key: s3Key,
      Body: bytes,
      ContentType: 'application/zip',
      // Best-effort metadata for forensics (stripped by S3 to lower-
      // case keys; values are short ASCII so no encoding issues).
      Metadata: {
        userid: String(job.userId),
        jobid: job.jobId,
        documents: String(counts.documents),
        comments: String(counts.comments)
      }
    }))

    await markJobReady({
      jobId: job.jobId,
      s3Key,
      sizeBytes: bytes.byteLength,
      retentionDays: DATA_EXPORT_RETENTION_DAYS
    })

    result.succeeded = true
    result.s3Key = s3Key

    // Audit + best-effort email.
    await appendAuditEvent({
      actorUserId: job.userId,
      actorIp: null,
      scope: 'user',
      scopeId: String(job.userId),
      action: AUDIT_ACCOUNT_EXPORT_COMPLETED,
      after: {
        jobId: job.jobId,
        s3Key,
        sizeBytes: bytes.byteLength,
        counts
      }
    })

    const user = await findUserById(job.userId)
    if (user?.email) {
      void safeSendTransactionalEmail({
        kind: 'data_export.ready',
        to: user.email,
        // user.locale isn't on findUserById's projection, so default to
        // null and let the email template fall back to its default locale.
        locale: null,
        subject: 'Your markoto data export is ready',
        body: `Your data export is ready to download. Sign in to /settings/profile and click "Download" — the link expires in ${DATA_EXPORT_RETENTION_DAYS} days.`,
        metadata: { userId: job.userId, jobId: job.jobId, sizeBytes: bytes.byteLength }
      })
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    result.errorMessage = msg
    log.error('export job failed', { jobId: job.jobId, err: e })
    Sentry.captureException(e, {
      tags: { component: 'dataExportWorker', event: 'job_failed', userId: String(job.userId) }
    })

    try {
      await markJobFailed(job.jobId, msg)
    } catch (markFailedErr) {
      // If we can't even update the row, log + Sentry; ops needs to
      // intervene manually. The row stays `running` and the next
      // sweep run can detect "stuck running" rows.
      log.error('markJobFailed itself failed', { jobId: job.jobId, err: markFailedErr })
      Sentry.captureException(markFailedErr, {
        tags: { component: 'dataExportWorker', event: 'mark_failed_failed', jobId: job.jobId }
      })
    }

    await appendAuditEvent({
      actorUserId: job.userId,
      actorIp: null,
      scope: 'user',
      scopeId: String(job.userId),
      action: AUDIT_ACCOUNT_EXPORT_FAILED,
      metadata: { jobId: job.jobId, errorMessage: msg.slice(0, 500) }
    })
  }

  return result
}
