import { PutObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { nanoid } from 'nanoid'
import { reservePendingUpload } from '../../repos/uploads'
import { imageQuotaError, resolveImageQuota } from '../../utils/storage/imageQuota'
import { buildUploadKey, stagingKeyFor } from '../../utils/storage/uploadKey'
import { IMAGE_UPLOAD_MAX_BYTES } from '~~/shared/config/uploads'
import { requestUploadBody } from '~~/shared/api/ai'
import { MINUTE_MS } from '~~/shared/config/units'
import { ownValue } from '~~/shared/utils/ownValue'
import { useEnv } from '~~/shared/env/load'

// Presigned PUT lifetime. S3 checks expiry when the request STARTS, so a
// slow 10 MB upload that begins in time still completes; a short window
// limits how long a leaked URL stays usable.
const IMAGE_PUT_TTL_SECONDS = 120

// SVG deliberately excluded: it can embed <script> and event handlers that run
// when the file is opened directly via the presigned S3 URL, and uploaded SVGs
// bypass the markdown pipeline's DOMPurify.
const CONTENT_TYPE_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp'
}

// Write access, the same rule as the editor's Y.js token
// (`decideTokenAccess`): owner / workspace admin+editor everywhere, anyone
// logged in on `open-edit` docs, never a workspace viewer (viewer wins over the
// public edit grant). The doc must exist (404): confirm resolves keys through
// the pending `uploads` row (FK to documents), and presigning for non-existent
// docs would hand out unlimited 10 MB PUT URLs.
export default defineApiHandler({
  access: allow.doc('write-content', { docId: { from: 'body' } }),
  body: requestUploadBody,
  rateLimit: { namespace: 'upload-request', max: 60, windowMs: MINUTE_MS, key: 'user', error: 'upload/rate-limited' },
  handler: async ({ user, body }) => {
    const { docId, contentType, size } = body
    const ext = ownValue(CONTENT_TYPE_EXT, contentType)
    if (!ext) throw apiError('upload/unsupported-format')
    if (size > IMAGE_UPLOAD_MAX_BYTES) throw apiError('upload/file-too-large')

    const s3 = usePresignS3Client()
    const env = useEnv()
    const fileId = nanoid(12)
    const key = buildUploadKey(docId, fileId, ext)

    // Insert an unconfirmed upload row BEFORE issuing the URL: /upload/confirm
    // only acts on keys with a row owned by the caller, and orphan cleanup reaps
    // uploads that never landed. The row is also the quota reservation; check +
    // insert are atomic per user so parallel requests can't jointly overshoot.
    // Team / Business workspace documents use the workspace's pool.
    const quota = await resolveImageQuota(user.id, docId)
    const quotaBytes = quota.maxBytes
    const reservation = await reservePendingUpload({
      docId,
      fileId: `${fileId}.${ext}`,
      uploaderId: user.id,
      contentType,
      sizeBytes: size,
      s3Key: key
    }, quotaBytes, quota.scope)
    if (!reservation.reserved) throw imageQuotaError(quotaBytes)

    // SSE: presigned PUTs deliberately omit `ServerSideEncryption`. SigV4 binds
    // every signed header, so the browser would have to echo
    // `x-amz-server-side-encryption: AES256` exactly. Encryption is enforced by
    // the bucket's default-encryption policy (docs/S3-SETUP.md section 6); server
    // side PUTs (renderer, AI image gen, backup sidecar) set the header
    // explicitly as defense in depth.
    //
    // CONTENT-TYPE IS SIGNED: unsigned, a client could PUT image bytes with any
    // stored type (e.g. `text/html`) and have the bucket serve them as that.
    // Signed, S3 rejects a mismatching PUT. Confirm re-checks the stored type and
    // `/api/files` forces it on the way out.
    //
    // STAGING KEY: the URL can only write `docs/{docId}/staging/{fileId}`.
    // Confirm copies it to `key` (what `/api/files` serves) and sniffs the copy,
    // so re-using the URL can't swap the bytes of a confirmed image. `key` is
    // still what the client confirms.
    const uploadUrl = await getSignedUrl(
      s3,
      new PutObjectCommand({
        Bucket: env.storage.bucket,
        Key: stagingKeyFor(key),
        ContentType: contentType,
        ContentLength: size
      }),
      { expiresIn: IMAGE_PUT_TTL_SECONDS, signableHeaders: new Set(['content-type']) }
    )

    return {
      uploadUrl,
      fileId: `${fileId}.${ext}`,
      key,
      expiresIn: IMAGE_PUT_TTL_SECONDS
    }
  }
})
