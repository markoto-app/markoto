import { GetObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { getDocWithActorRole } from '../../../repos/documents'
import { decideFileAccess, type DocState, type ActorState } from '../../../../shared/utils/docPermissions'
import { hasValidDocJwt } from '../../../utils/docTokenVerify'

// fileId is a nanoid(12) with a content-type-derived extension. Reject
// anything else — not a security boundary (S3 keys are opaque, no
// traversal risk), but keeps malformed clients from generating
// presigned URLs for nonsense keys.
const FILE_ID_RE = /^[A-Za-z0-9_-]{1,64}\.(png|jpg|jpeg|gif|webp)$/

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

  const doc: DocState = {
    ownerId: row.ownerId,
    workspaceId: row.workspaceId,
    accessMode: row.accessMode
  }
  const actor: ActorState = {
    userId: session?.user?.id ?? null,
    workspaceRole: row.workspaceRole,
    hasValidDocJwt: hasValidDocJwt(event, docId)
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
  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: config.s3.bucket,
      Key: key
    }),
    { expiresIn: 120 }
  )

  return sendRedirect(event, url, 302)
})
