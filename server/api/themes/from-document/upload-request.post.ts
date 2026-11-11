import { PutObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { nanoid } from 'nanoid'
import {
  DESIGN_IMPORT_MAX_BYTES,
  DESIGN_IMPORT_MIME,
  isDesignImportExt
} from '~~/shared/config/designImport'
import { designImportStagingKey, recordPendingDesignUpload, requireVisionChatProvider } from '../../../utils/designImport/guard'

/**
 * "Create a design from a document", step 1: presigned PUT for the file.
 *
 * Guard order (fail early, before the user uploads anything):
 *   1. signed in
 *   2. per-user rate limit — every run spends AI on the user's provider
 *   3. a vision-capable chat provider (409 with a settings link otherwise)
 *   4. extension (pdf / docx) + size (≤ 20 MB)
 *
 * The URL writes a per-user STAGING key with content type + length
 * signed; `start` reads it, sniffs the bytes it read and deletes it. An
 * object that is never started is reaped by orphan-cleanup after an hour.
 */

const PUT_TTL_SECONDS = 120
/** Runs per user per hour (each is up to three vision calls). */
export const DESIGN_IMPORT_HOURLY_LIMIT = 10

export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const userId = session.user.id

  if (!(await checkRateLimit('design-import', String(userId), DESIGN_IMPORT_HOURLY_LIMIT, 60 * 60_000))) {
    throw createError({
      statusCode: 429,
      message: 'You have created many designs in the last hour. Try again later.',
      data: { code: 'design-import/rate-limited', messageKey: 'designImport.errors.rate-limited' }
    })
  }

  await requireVisionChatProvider(userId)

  const body = await readBody<{ filename?: unknown, size?: unknown }>(event)
  const filename = typeof body?.filename === 'string' ? body.filename.trim() : ''
  const size = typeof body?.size === 'number' ? body.size : Number.NaN
  if (!filename || filename.length > 255) {
    throw createError({ statusCode: 400, message: 'filename is required (max 255 characters)' })
  }
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''
  if (!isDesignImportExt(ext)) {
    throw createError({
      statusCode: 415,
      message: 'Choose a PDF or Word (.docx) file.',
      data: { code: 'design-import/unsupported-format', messageKey: 'designImport.errors.format' }
    })
  }
  if (!Number.isInteger(size) || size <= 0) {
    throw createError({ statusCode: 400, message: 'size must be a positive integer' })
  }
  if (size > DESIGN_IMPORT_MAX_BYTES) {
    throw createError({
      statusCode: 413,
      message: 'The file is larger than 20 MB.',
      data: { code: 'design-import/too-large', messageKey: 'designImport.errors.too-large' }
    })
  }

  const config = useRuntimeConfig()
  const uploadId = nanoid(16)
  const stagingKey = designImportStagingKey(userId, uploadId, ext)
  const mimeType = DESIGN_IMPORT_MIME[ext]
  // SSE: presigned PUTs omit `ServerSideEncryption` (the bucket default covers
  // them, see server/api/upload/request.post.ts).
  const uploadUrl = await getSignedUrl(
    usePresignS3Client(),
    new PutObjectCommand({ Bucket: config.s3.bucket, Key: stagingKey, ContentType: mimeType, ContentLength: size }),
    { expiresIn: PUT_TTL_SECONDS, signableHeaders: new Set(['content-type']) }
  )
  await recordPendingDesignUpload(userId, uploadId, { stagingKey, ext, mimeType, size })

  return { uploadId, uploadUrl, mimeType, expiresIn: PUT_TTL_SECONDS }
})
