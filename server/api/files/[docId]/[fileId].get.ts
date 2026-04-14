import { GetObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { eq } from 'drizzle-orm'
import { documents } from '../../../db/schema'

export default defineEventHandler(async (event) => {
  const docId = requireDocId(event)
  const fileId = requireRouteParam(event, 'fileId')

  // Check document access — password-protected docs require auth
  const db = useDatabase()
  const doc = (await db.select({ accessMode: documents.accessMode, ownerId: documents.ownerId })
    .from(documents)
    .where(eq(documents.docId, docId))
    .limit(1))[0]

  if (doc?.accessMode === 'password-protected') {
    const session = await getValidatedUserSession(event)
    const isOwner = doc.ownerId != null && doc.ownerId === session?.user.id
    if (!isOwner) {
      throw createError({ statusCode: 403, message: 'Access denied' })
    }
  }

  const s3 = useS3Client()
  const config = useRuntimeConfig()
  const key = `docs/${docId}/${fileId}`

  // Short TTL because a presigned URL cannot be revoked — it remains valid for
  // its full lifetime even if the document is deleted, its access mode is
  // tightened, or the password is rotated. 120s is enough for the browser to
  // follow the 302 and fetch the bytes; anything longer is a surface area we
  // don't want. Callers that need the bytes again will be re-authorized.
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
