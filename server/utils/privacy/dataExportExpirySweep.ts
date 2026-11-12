import * as Sentry from '@sentry/nuxt'
import { DeleteObjectCommand } from '@aws-sdk/client-s3'
import { markExpiredJobs } from '../../repos/dataExportJobs'
import { useS3Client } from '../storage/s3'
import { useEnv } from '~~/shared/env/load'
import { useLogger } from '../platform/logger'

const log = useLogger('data-export-expiry')

// Expiry sweeper for data-export jobs. Hourly. Picks rows whose
// `expires_at` has elapsed AND status is `ready`, flips them to
// `expired`, and deletes the corresponding S3 blob.
//
// **Idempotent.** A row that's already `expired` doesn't match the
// `markExpiredJobs` predicate. A blob that's already gone returns a
// success-shaped response from S3 (DeleteObject is idempotent on
// missing keys).
//
// **Best-effort S3 cleanup.** A wedged S3 must not block the row
// flip — the row is the source of truth for "user can no longer
// download this", and an orphan S3 blob will be reaped by the
// bucket lifecycle policy (configured at deploy time per
// docs/S3-SETUP.md).

export interface DataExportExpirySweepResult {
  expired: number
  s3DeleteSucceeded: number
  s3DeleteFailed: number
}

export async function runDataExportExpirySweep(): Promise<DataExportExpirySweepResult> {
  const flipped = await markExpiredJobs()
  const result: DataExportExpirySweepResult = {
    expired: flipped.length,
    s3DeleteSucceeded: 0,
    s3DeleteFailed: 0
  }

  if (flipped.length === 0) return result

  const env = useEnv()
  const s3 = useS3Client()

  for (const row of flipped) {
    if (!row.s3Key) continue
    try {
      await s3.send(new DeleteObjectCommand({
        Bucket: env.storage.bucket,
        Key: row.s3Key
      }))
      result.s3DeleteSucceeded += 1
    } catch (e) {
      result.s3DeleteFailed += 1
      log.warn('S3 delete failed', { s3Key: row.s3Key, err: e })
      Sentry.captureException(e, {
        tags: { component: 'dataExportExpirySweep', event: 's3_delete_failed', jobId: row.jobId }
      })
    }
  }

  log.info('data export expiry sweep finished', { expired: result.expired, s3Deleted: result.s3DeleteSucceeded, s3Failed: result.s3DeleteFailed })
  return result
}
