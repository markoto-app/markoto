import { GetObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { getJobForUser } from '../../../../repos/dataExportJobs'
import { usePresignS3Client } from '../../../../utils/s3'

// 302 → presigned download URL for a ready data-export ZIP. Tuple-
// keyed on (jobId, userId) so a guess-the-jobId attempt can't 404
// versus 200 distinguish a sibling user's job. Expiry is enforced
// twice: by the row's `expires_at` and by S3 itself once the
// expiry sweeper has deleted the blob.
//
// Presigned URL TTL: 5 minutes — tight enough that a leaked link
// has limited reuse, long enough that a slow client connection
// (hotel wifi mid-download) doesn't fail.
//
// `ContentDisposition` is baked into the presigned URL so the
// browser saves the file with a sensible name rather than the
// opaque jobId.zip.

export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const jobId = getRouterParam(event, 'jobId')
  if (!jobId) throw createError({ statusCode: 400, message: 'jobId required' })

  const job = await getJobForUser(jobId, session.user.id)
  if (!job) {
    // 404 regardless of whether the job exists — we don't want to
    // leak the existence of jobs belonging to other users.
    throw createError({ statusCode: 404, message: 'Export not found' })
  }

  if (job.status !== 'ready') {
    throw createError({
      statusCode: 409,
      message: `Export is ${job.status}; only ready exports can be downloaded.`,
      data: { code: 'export/not-ready', status: job.status }
    })
  }

  if (!job.s3Key) {
    // Internal invariant violation — `ready` rows always have an
    // s3_key. Surface as 500 so ops sees it.
    throw createError({ statusCode: 500, message: 'Export missing S3 key' })
  }

  if (job.expiresAt && job.expiresAt <= new Date()) {
    throw createError({
      statusCode: 410,
      message: 'This export has expired. Please request a new one.',
      data: { code: 'export/expired' }
    })
  }

  const config = useRuntimeConfig()
  const s3 = usePresignS3Client()

  // Filename: include the job's create-date for the user's
  // convenience. Avoid PII in the filename — no user id, no email.
  const dateStamp = job.createdAt.toISOString().slice(0, 10)
  const filename = `markoto-data-export-${dateStamp}.zip`

  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: config.s3.bucket,
      Key: job.s3Key,
      ResponseContentDisposition: `attachment; filename="${filename}"`,
      ResponseContentType: 'application/zip',
      // The download itself is per-user data too.
      ResponseCacheControl: PRIVATE_NO_STORE
    }),
    { expiresIn: 5 * 60 }
  )

  return sendPrivateRedirect(event, url)
})
