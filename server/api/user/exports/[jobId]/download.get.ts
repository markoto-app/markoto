import { GetObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { getJobForUser } from '../../../../repos/dataExportJobs'
import { usePresignS3Client } from '../../../../utils/storage/s3'
import { exportJobParams } from '~~/shared/api/account'
import { useEnv } from '~~/shared/env/load'

// 302 → presigned download URL for a ready data-export ZIP. Tuple-
// keyed on (jobId, userId) so a guess-the-jobId attempt can't 404
// versus 200 distinguish a sibling user's job. Expiry is enforced
// twice: by the row's `expires_at` and by S3 itself once the
// expiry sweeper has deleted the blob.
//
// Presigned URL TTL: 5 minutes, tight enough that a leaked link
// has limited reuse, long enough that a slow client connection
// (hotel wifi mid-download) doesn't fail.
//
// `ContentDisposition` is baked into the presigned URL so the
// browser saves the file with a sensible name rather than the
// opaque jobId.zip.

export default defineApiHandler({
  access: allow.user(),
  params: exportJobParams,
  handler: async ({ event, params, self }) => {
    const job = await getJobForUser(self, params.jobId)
    if (!job) {
    // 404 regardless of whether the job exists, we don't want to
    // leak the existence of jobs belonging to other users.
      throw apiError('export/not-found')
    }

    if (job.status !== 'ready') throw apiError('export/not-ready', { status: job.status })

    if (!job.s3Key) {
    // Internal invariant violation: `ready` rows always have an
    // s3_key. Surface as 500 so ops sees it.
      throw apiError('internal')
    }

    if (job.expiresAt && job.expiresAt <= new Date()) throw apiError('export/expired')

    const env = useEnv()
    const s3 = usePresignS3Client()

    // Filename: include the job's create-date for the user's
    // convenience. Avoid PII in the filename, no user id, no email.
    const dateStamp = job.createdAt.toISOString().slice(0, 10)
    const filename = `markoto-data-export-${dateStamp}.zip`

    const url = await getSignedUrl(
      s3,
      new GetObjectCommand({
        Bucket: env.storage.bucket,
        Key: job.s3Key,
        ResponseContentDisposition: `attachment; filename="${filename}"`,
        ResponseContentType: 'application/zip',
        // The download itself is per-user data too.
        ResponseCacheControl: PRIVATE_NO_STORE
      }),
      { expiresIn: 5 * 60 }
    )

    return sendPrivateRedirect(event, url)
  }
})
