import { GetObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { getDocWithActorRole } from '../../../repos/documents'
import { docStateOf, decideFileAccess, type DocState, type ActorState } from '../../../../shared/utils/documents/docPermissions'
import { hasValidDocJwt } from '../../../utils/documents/docTokenVerify'
import { ID_PATTERN } from '~~/shared/config/identifiers'

// fileId is a nanoid(12) with a content-type-derived extension. Not a security
// boundary (S3 keys are opaque); it just stops malformed clients from presigning
// nonsense keys.
const FILE_ID_RE = new RegExp(`^${ID_PATTERN}\\.(png|jpg|jpeg|gif|webp)$`)

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

  // Gone from the DB: refuse to sign, else a deleted doc whose S3 objects
  // outlived best-effort cleanup would be readable by anyone guessing the ids.
  if (!row) {
    throw createError({ statusCode: 404, message: 'Document not found' })
  }

  const doc: DocState = docStateOf(row)
  const actor: ActorState = {
    userId: session?.user?.id ?? null,
    workspaceRole: row.workspaceRole,
    // `file-access` tokens come from the render page and the live preview iframe
    // (neither has the session cookie).
    hasValidDocJwt: hasValidDocJwt(event, docId, ['file-access'])
  }

  const decision = decideFileAccess(doc, actor)
  if (decision.outcome === 'deny') {
    throw createError({ statusCode: 403, message: 'Access denied' })
  }

  const s3 = usePresignS3Client()
  const config = useRuntimeConfig()
  const key = `docs/${docId}/${fileId}`

  // Short TTL because a presigned URL can't be revoked: it outlives a deletion,
  // access-mode change or password rotation. 120s is enough to follow the 302.
  //
  // The response type is forced from the file extension (`response-content-type`)
  // rather than the stored type: an image URL must never be served as HTML,
  // even for objects uploaded before the type was bound at upload.
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
