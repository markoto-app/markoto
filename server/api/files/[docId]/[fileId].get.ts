import { GetObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { and, eq } from 'drizzle-orm'
import { documents, workspaceMembers } from '../../../db/schema'
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

  const db = useDatabase()
  const docRow = (await db
    .select({
      accessMode: documents.accessMode,
      ownerId: documents.ownerId,
      workspaceId: documents.workspaceId
    })
    .from(documents)
    .where(eq(documents.docId, docId))
    .limit(1))[0]

  // Gone from the DB → refuse to sign. Without this the endpoint would
  // happily presign for a deleted doc whose S3 objects outlived the
  // best-effort cleanup, exposing orphan content to anyone guessing the
  // docId / fileId pair.
  if (!docRow) {
    throw createError({ statusCode: 404, message: 'Document not found' })
  }

  const session = await getValidatedUserSession(event)

  // Look up workspace role only if there's something to look up. For anon
  // requests or docs without a workspace this is a no-op — the decision
  // function handles the null role.
  let workspaceRole: 'admin' | 'editor' | 'viewer' | null = null
  if (docRow.workspaceId && typeof session?.user?.id === 'number') {
    const memberRow = (await db
      .select({ role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(and(
        eq(workspaceMembers.workspaceId, docRow.workspaceId),
        eq(workspaceMembers.userId, session.user.id)
      ))
      .limit(1))[0]
    workspaceRole = (memberRow?.role ?? null) as typeof workspaceRole
  }

  const doc: DocState = {
    ownerId: docRow.ownerId,
    workspaceId: docRow.workspaceId,
    accessMode: docRow.accessMode
  }
  const actor: ActorState = {
    userId: session?.user?.id ?? null,
    workspaceRole,
    hasValidDocJwt: hasValidDocJwt(event, docId)
  }

  const decision = decideFileAccess(doc, actor)
  if (decision.outcome === 'deny') {
    throw createError({ statusCode: 403, message: 'Access denied' })
  }

  const s3 = useS3Client()
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
