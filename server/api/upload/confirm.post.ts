import { HeadObjectCommand } from '@aws-sdk/client-s3'

export default defineEventHandler(async (event) => {
  const { key } = await readBody(event)

  if (!key) {
    throw createError({ statusCode: 400, message: 'Missing key' })
  }

  const s3 = useS3Client()
  const config = useRuntimeConfig()

  try {
    const head = await s3.send(new HeadObjectCommand({
      Bucket: config.s3.bucket,
      Key: key
    }))

    return {
      success: true,
      size: head.ContentLength,
      contentType: head.ContentType
    }
  } catch {
    throw createError({ statusCode: 404, message: 'Upload not found in S3' })
  }
})
