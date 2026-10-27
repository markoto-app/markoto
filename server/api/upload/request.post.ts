import { PutObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { nanoid } from 'nanoid'
import { reservePendingUpload } from '../../repos/uploads'
import { requireDocEditAccess } from '../../utils/documentAccess'
import { imageQuotaError, resolveImageQuotaBytes } from '../../utils/imageQuota'
import { buildUploadKey, DOC_ID_RE, stagingKeyFor } from '../../utils/uploadKey'

// Presigned PUT lifetime. S3 checks expiry when the request STARTS, so a
// slow 10 MB upload that begins in time still completes; a short window
// limits how long a leaked URL stays usable.
const IMAGE_PUT_TTL_SECONDS = 120

// SVG deliberately excluded — SVG can embed <script> and event handlers
// that execute when the file is opened directly (right-click → open,
// anchor link to the presigned S3 URL). The markdown pipeline's
// DOMPurify blocks inline SVG, but uploaded SVGs bypass that path
// entirely.
const CONTENT_TYPE_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp'
}
const MAX_SIZE = 10 * 1024 * 1024 // 10 MB

export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  if (!(await checkRateLimit('upload-request', String(session.user.id), 60, 60_000))) {
    throw createError({
      statusCode: 429,
      message: 'Too many uploads. Try again in a minute.',
      data: { code: 'upload/rate-limited' }
    })
  }
  const { docId, filename, contentType, size } = await readBody(event)

  if (!docId || !filename || !contentType) {
    throw createError({ statusCode: 400, message: 'Missing required fields: docId, filename, contentType' })
  }
  if (typeof docId !== 'string' || !DOC_ID_RE.test(docId)) {
    throw createError({ statusCode: 400, message: 'Invalid docId' })
  }
  // A positive integer: the size is signed into the PUT and reserved
  // against the quota, so a negative or fractional value must not pass.
  if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0) {
    throw createError({ statusCode: 400, message: 'Missing or invalid file size' })
  }
  const ext = CONTENT_TYPE_EXT[contentType]
  if (!ext) {
    throw createError({
      statusCode: 415,
      message: `Type not allowed: ${contentType}`,
      data: { code: 'upload/unsupported-format' }
    })
  }
  if (size > MAX_SIZE) {
    throw createError({
      statusCode: 413,
      message: 'File too large. Max 10MB.',
      data: { code: 'upload/file-too-large' }
    })
  }

  // Verify the user has write access to this document — the same rule
  // as the editor's Y.js token (`requireDocEditAccess` →
  // `decideTokenAccess`): owner / workspace admin+editor everywhere,
  // anyone logged in on `open-edit` docs, and never a workspace viewer
  // (viewer wins over the public edit grant). The doc must exist (404):
  // confirm resolves keys through the pending `uploads` row (FK to
  // documents), and presigning for non-existent docs would hand out
  // unlimited 10 MB PUT URLs into the bucket.
  await requireDocEditAccess(docId, session.user.id)

  const s3 = usePresignS3Client()
  const config = useRuntimeConfig()
  const fileId = nanoid(12)
  const key = buildUploadKey(docId, fileId, ext)

  // Insert an unconfirmed upload row BEFORE issuing the URL: /upload/confirm
  // only acts on keys with a row owned by the caller, and the orphan cleanup
  // uses it to reap uploads that never landed. The row is also the quota
  // reservation: check + insert are atomic per user, so parallel requests
  // can't jointly overshoot the image storage quota.
  const quotaBytes = await resolveImageQuotaBytes(session.user.id)
  const reservation = await reservePendingUpload({
    docId,
    fileId: `${fileId}.${ext}`,
    uploaderId: session.user.id,
    contentType,
    sizeBytes: size,
    s3Key: key
  }, quotaBytes)
  if (!reservation.reserved) throw imageQuotaError(quotaBytes)

  // SSE NOTE: presigned PUTs deliberately omit `ServerSideEncryption` —
  // SigV4 binds every signed header into the URL, which would force the
  // browser to echo `x-amz-server-side-encryption: AES256` exactly or
  // get a SignatureDoesNotMatch. Encryption is enforced at the bucket
  // level via the default-encryption policy (docs/S3-SETUP.md §6) so
  // every PUT — presigned or not — gets AES256-at-rest regardless.
  // Server-side direct PUTs (renderer, AI image gen, backup sidecar)
  // set the header explicitly as defense-in-depth.
  //
  // CONTENT-TYPE IS SIGNED: the presigner leaves it unsigned by default,
  // which would let the client PUT image bytes with any stored type
  // (e.g. `text/html`) and have the bucket serve them as that type. With
  // `content-type` in the signed headers the browser must send exactly
  // the type requested here, or S3 rejects the PUT. Confirm re-checks the
  // stored type, and `/api/files` forces it on the way out.
  //
  // STAGING KEY: the URL can only write `docs/{docId}/staging/{fileId}`.
  // Confirm copies that object to `key` (what `/api/files` serves) and
  // sniffs the copy, so re-using the URL after confirm can't swap the
  // bytes of a confirmed image. `key` is still what the client confirms.
  const uploadUrl = await getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: config.s3.bucket,
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
})
