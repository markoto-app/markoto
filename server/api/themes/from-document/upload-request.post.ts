import { PutObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { nanoid } from 'nanoid'
import {
  DESIGN_IMPORT_MAX_BYTES,
  DESIGN_IMPORT_MIME,
  isDesignImportExt
} from '~~/shared/config/designImport'
import { designImportStagingKey, recordPendingDesignUpload, requireVisionChatProvider } from '../../../utils/designImport/guard'
import { designImportUploadRequestBody } from '~~/shared/api/brand'
import { HOUR_MS } from '~~/shared/config/units'
import { useEnv } from '~~/shared/env/load'

/**
 * "Create a design from a document", step 1: presigned PUT for the file.
 *
 * Guard order (fail early, before the user uploads anything): signed in,
 * request shape, per-user rate limit (every run spends AI on the user's
 * provider), a vision-capable chat provider (409 with a settings link
 * otherwise), then extension (pdf / docx) + size (≤ 20 MB).
 *
 * The URL writes a per-user STAGING key with content type + length
 * signed; `start` reads it, sniffs the bytes it read and deletes it. An
 * object that is never started is reaped by orphan-cleanup after an hour.
 */

const PUT_TTL_SECONDS = 120
/** Runs per user per hour (each is up to three vision calls). */
export const DESIGN_IMPORT_HOURLY_LIMIT = 10

export default defineApiHandler({
  access: allow.user(),
  body: designImportUploadRequestBody,
  rateLimit: { namespace: 'design-import', max: DESIGN_IMPORT_HOURLY_LIMIT, windowMs: HOUR_MS, key: 'user', error: 'design-import/rate-limited' },
  handler: async ({ user, body: { filename, size } }) => {
    const userId = user.id
    await requireVisionChatProvider(userId)

    const ext = filename.split('.').pop()?.toLowerCase() ?? ''
    if (!isDesignImportExt(ext)) throw apiError('design-import/unsupported-format')
    if (size > DESIGN_IMPORT_MAX_BYTES) throw apiError('design-import/too-large')

    const env = useEnv()
    const uploadId = nanoid(16)
    const stagingKey = designImportStagingKey(userId, uploadId, ext)
    const mimeType = DESIGN_IMPORT_MIME[ext]
    // SSE: presigned PUTs omit `ServerSideEncryption` (the bucket default covers
    // them, see server/api/upload/request.post.ts).
    const uploadUrl = await getSignedUrl(
      usePresignS3Client(),
      new PutObjectCommand({ Bucket: env.storage.bucket, Key: stagingKey, ContentType: mimeType, ContentLength: size }),
      { expiresIn: PUT_TTL_SECONDS, signableHeaders: new Set(['content-type']) }
    )
    await recordPendingDesignUpload(userId, uploadId, { stagingKey, ext, mimeType, size })

    return { uploadId, uploadUrl, mimeType, expiresIn: PUT_TTL_SECONDS }
  }
})
