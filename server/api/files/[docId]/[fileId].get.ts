import { GetObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { getDocWithActorRole } from '../../../repos/documents'
import { docStateOf, decideFileAccess, type DocState, type ActorState } from '../../../../shared/utils/docPermissions'
import { hasValidDocJwt } from '../../../utils/docTokenVerify'

// fileId is a nanoid(12) with a content-type-derived extension. Reject
// anything else — not a security boundary (S3 keys are opaque, no
// traversal risk), but keeps malformed clients from generating
// presigned URLs for nonsense keys.
const FILE_ID_RE = /^[A-Za-z0-9_-]{1,64}\.(png|jpg|jpeg|gif|webp)$/

const EXT_CONTENT_TYPE: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp'
}

export default defineEventHandler(async (event) => {
  const docId = requireDocId(event)
  const fileId = requireRouteParam(event, 'fileId')

  if (!FILE_ID_RE.test(fileId)) {
    throw createError({ statusCode: 400, message: 'Invalid file id' })
  }

  const session = await getValidatedUserSession(event)
  const row = await getDocWithActorRole(docId, session?.user?.id ?? null)

  // Gone from the DB → refuse to sign. Without this the endpoint would
  // happily presign for a deleted doc whose S3 objects outlived the
  // best-effort cleanup, exposing orphan content to anyone guessing the
  // docId / fileId pair.
  if (!row) {
    throw createError({ statusCode: 404, message: 'Document not found' })
  }

  const doc: DocState = docStateOf(row)
  const actor: ActorState = {
    userId: session?.user?.id ?? null,
    workspaceRole: row.workspaceRole,
    // `file-access` tokens come from the render page and the live
    // preview iframe (both run without the session cookie).
    hasValidDocJwt: hasValidDocJwt(event, docId, ['file-access'])
  }

  const decision = decideFileAccess(doc, actor)
  if (decision.outcome === 'deny') {
    throw createError({ statusCode: 403, message: 'Access denied' })
  }

  const s3 = usePresignS3Client()
  const config = useRuntimeConfig()
  const key = `docs/${docId}/${fileId}`

  // Short TTL because a presigned URL cannot be revoked — it remains valid
  // for its full lifetime even if the document is deleted, its access mode
  // is tightened, or the password is rotated. 120s is enough for the browser
  // to follow the 302 and fetch the bytes; anything longer is surface area
  // we don't want. Callers that need the bytes again will be re-authorized.
  //
  // The response type is forced from the file extension (S3's
  // `response-content-type` override) instead of trusting whatever type
  // the object was stored with: an image URL must never be served as
  // HTML, even for objects uploaded before the type was bound at upload.
  const ext = fileId.slice(fileId.lastIndexOf('.') + 1).toLowerCase()
  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: config.s3.bucket,
      Key: key,
      ResponseContentType: EXT_CONTENT_TYPE[ext] ?? 'application/octet-stream',
      ResponseContentDisposition: `inline; filename="${fileId}"`
    }),
    { expiresIn: 120 }
  )

  return sendPrivateRedirect(event, url)
})
