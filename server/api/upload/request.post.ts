import { PutObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { nanoid } from 'nanoid'
import { getDoc } from '../../repos/documents'
import { recordPending } from '../../repos/uploads'
import { canEditDoc } from '../../utils/workspaceAccess'

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

// nanoid alphabet + a generous length window. Any docId that doesn't
// match this gets rejected before being interpolated into the S3 key —
// without this, `docId: "../other-doc"` is signed for an arbitrary key.
const DOC_ID_RE = /^[A-Za-z0-9_-]{8,32}$/

export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
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
  const doc = await getDoc(docId)
  if (doc) {
    if (doc.accessMode !== 'open-edit' && !(await canEditDoc(session.user.id, docId))) {
      throw createError({ statusCode: 403, message: 'No write access to this document' })
    }
  }
  // If doc doesn't exist in DB yet (new anonymous doc), allow upload since user is authenticated

  const s3 = useS3Client()
  const config = useRuntimeConfig()
  const fileId = nanoid(12)
  const key = `docs/${docId}/${fileId}.${ext}`

  // Insert an unconfirmed upload row BEFORE issuing the URL so the
  // orphan cleanup has a record to compare against. If the user never
  // PUTs the file, this row stays unconfirmed and gets reaped after
  // 24h. If the doc itself doesn't exist in DB yet (anonymous-doc edge
  // case), skip the insert — there's no FK target.
  if (doc) {
    await recordPending({
      docId,
      fileId: `${fileId}.${ext}`,
      uploaderId: session.user.id,
      contentType,
      sizeBytes: size,
      s3Key: key
    })
  }

  // SSE NOTE: presigned PUTs deliberately omit `ServerSideEncryption` —
  // SigV4 binds every signed header into the URL, which would force the
  // browser to echo `x-amz-server-side-encryption: AES256` exactly or
  // get a SignatureDoesNotMatch. Encryption is enforced at the bucket
  // level via the default-encryption policy (docs/S3-SETUP.md §6) so
  // every PUT — presigned or not — gets AES256-at-rest regardless.
  // Server-side direct PUTs (renderer, AI image gen, backup sidecar)
  // set the header explicitly as defense-in-depth.
  const uploadUrl = await getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: config.s3.bucket,
      Key: key,
      ContentType: contentType,
      ContentLength: size
    }),
    { expiresIn: 300 }
  )

  return {
    uploadUrl,
    fileId: `${fileId}.${ext}`,
    key,
    expiresIn: 300
  }
})
