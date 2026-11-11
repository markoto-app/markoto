import * as Sentry from '@sentry/nuxt'
import { DeleteObjectCommand } from '@aws-sdk/client-s3'
import { markExpiredJobs } from '../../repos/dataExportJobs'
import { useS3Client } from '../storage/s3'

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

  const config = useRuntimeConfig()
  const s3 = useS3Client()

  for (const row of flipped) {
    if (!row.s3Key) continue
    try {
      await s3.send(new DeleteObjectCommand({
        Bucket: config.s3.bucket,
        Key: row.s3Key
      }))
      result.s3DeleteSucceeded += 1
    } catch (e) {
      result.s3DeleteFailed += 1
      console.warn(`[dataExportExpirySweep] s3 delete failed for ${row.s3Key}:`, e instanceof Error ? e.message : e)
      Sentry.captureException(e, {
        tags: { component: 'dataExportExpirySweep', event: 's3_delete_failed', jobId: row.jobId }
      })
    }
  }

  console.log(
    `[dataExportExpirySweep] expired=${result.expired} s3Ok=${result.s3DeleteSucceeded} s3Fail=${result.s3DeleteFailed}`
  )
  return result
}
