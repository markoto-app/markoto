import { HeadObjectCommand } from '@aws-sdk/client-s3'
import { markConfirmed } from '../../repos/uploads'

export default defineEventHandler(async (event) => {
  const { key } = await readBody(event)

  if (!key) {
    throw createError({ statusCode: 400, message: 'Missing key' })
  }

  const s3 = useS3Client()
  const config = useRuntimeConfig()

  let head
  try {
    head = await s3.send(new HeadObjectCommand({
      Bucket: config.s3.bucket,
      Key: key
    }))
  } catch {
    throw createError({ statusCode: 404, message: 'Upload not found in S3' })
  }

  // Flip the matching uploads row to confirmed. We don't fail if the row is
  // missing (anonymous-doc upload path doesn't create a row) — the HEAD
  // check above is the real "did it land in S3" gate.
  await markConfirmed(key)

  return {
    success: true,
    size: head.ContentLength,
    contentType: head.ContentType
  }
})
