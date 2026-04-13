import { PutObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { nanoid } from 'nanoid'
import { eq } from 'drizzle-orm'
import { documents } from '../../db/schema'

const ALLOWED_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'
])
const MAX_SIZE = 10 * 1024 * 1024 // 10 MB

export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const { docId, filename, contentType, size } = await readBody(event)

  if (!docId || !filename || !contentType) {
    throw createError({ statusCode: 400, message: 'Missing required fields: docId, filename, contentType' })
  }
  if (!size || typeof size !== 'number') {
    throw createError({ statusCode: 400, message: 'Missing or invalid file size' })
  }
  if (!ALLOWED_TYPES.has(contentType)) {
    throw createError({ statusCode: 415, message: `Type not allowed: ${contentType}` })
  }
  if (size > MAX_SIZE) {
    throw createError({ statusCode: 413, message: 'File too large. Max 10MB.' })
  }

  // Verify user has write access to this document
  const db = useDatabase()
  const doc = db.select().from(documents).where(eq(documents.docId, docId)).get()

  if (doc) {
    // If doc exists and is view-only, only the owner can upload
    if (doc.accessMode === 'open-view' && doc.ownerId !== session.user.id) {
      throw createError({ statusCode: 403, message: 'No write access to this document' })
    }
  }
  // If doc doesn't exist in DB yet (new anonymous doc), allow upload since user is authenticated

  const s3 = useS3Client()
  const config = useRuntimeConfig()
  const fileId = nanoid(12)
  const ext = filename.split('.').pop() || 'bin'
  const key = `docs/${docId}/${fileId}.${ext}`

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
