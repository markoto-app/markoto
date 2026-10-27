import { PutObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { nanoid } from 'nanoid'
import { getDoc } from '../../repos/documents'
import { recordPending } from '../../repos/uploads'
import { canEditDoc } from '../../utils/workspaceAccess'
import { buildUploadKey, DOC_ID_RE } from '../../utils/uploadKey'

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
  if (!size || typeof size !== 'number') {
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

  // Verify the user has write access to this document. `open-edit` docs are
  // editable by anyone (that's the feature — upload still requires a logged-in
  // session, gated above). For every other access mode — `open-view`,
  // `private`, `password-protected` — only the owner or a workspace
  // admin/editor may upload. The previous check only covered `open-view`
  // non-owners, so any authenticated user who knew a private/password doc id
  // could presign a PUT into that doc's S3 prefix (and it wrongly blocked
  // workspace editors on open-view docs). `canEditDoc` is the same content-edit
  // gate every other write endpoint uses.
  // The doc must exist: confirm resolves keys through the pending `uploads`
  // row (FK to documents), and presigning for non-existent docs would hand
  // out unlimited 10 MB PUT URLs into the bucket.
  const doc = await getDoc(docId)
  if (!doc) {
    throw createError({ statusCode: 404, message: 'Document not found' })
  }
  if (doc.accessMode !== 'open-edit' && !(await canEditDoc(session.user.id, docId))) {
    throw createError({ statusCode: 403, message: 'No write access to this document' })
  }

  const s3 = usePresignS3Client()
  const config = useRuntimeConfig()
  const fileId = nanoid(12)
  const key = buildUploadKey(docId, fileId, ext)

  // Insert an unconfirmed upload row BEFORE issuing the URL: /upload/confirm
  // only acts on keys with a row owned by the caller, and the orphan cleanup
  // uses it to reap uploads that never landed.
  await recordPending({
    docId,
    fileId: `${fileId}.${ext}`,
    uploaderId: session.user.id,
    contentType,
    sizeBytes: size,
    s3Key: key
  })

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
  const uploadUrl = await getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: config.s3.bucket,
      Key: key,
      ContentType: contentType,
      ContentLength: size
    }),
    { expiresIn: 300, signableHeaders: new Set(['content-type']) }
  )

  return {
    uploadUrl,
    fileId: `${fileId}.${ext}`,
    key,
    expiresIn: 300
  }
})
