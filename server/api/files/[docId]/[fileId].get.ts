import { GetObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { eq } from 'drizzle-orm'
import { documents } from '../../../db/schema'

export default defineEventHandler(async (event) => {
  const docId = getRouterParam(event, 'docId')
  const fileId = getRouterParam(event, 'fileId')

  if (!docId || !fileId) {
    throw createError({ statusCode: 400, message: 'Missing docId or fileId' })
  }

  // Check document access — password-protected docs require auth
  const db = useDatabase()
  const doc = db.select({ accessMode: documents.accessMode, ownerId: documents.ownerId })
    .from(documents)
    .where(eq(documents.docId, docId))
    .get()

  if (doc?.accessMode === 'password-protected') {
    const session = await getUserSession(event)
    const isOwner = doc.ownerId != null
      && typeof session?.user?.id === 'number'
      && doc.ownerId === session.user.id
    if (!isOwner) {
      throw createError({ statusCode: 403, message: 'Access denied' })
    }
  }

  const s3 = useS3Client()
  const config = useRuntimeConfig()
  const key = `docs/${docId}/${fileId}`

  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: config.s3.bucket,
      Key: key
    }),
    { expiresIn: 3600 }
  )

  return sendRedirect(event, url, 302)
})
