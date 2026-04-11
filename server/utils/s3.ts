import { S3Client } from '@aws-sdk/client-s3'

let s3: S3Client | null = null

export function useS3Client(): S3Client {
  if (!s3) {
    const config = useRuntimeConfig()
    s3 = new S3Client({
      endpoint: config.s3.endpoint,
      region: 'us-east-1',
      credentials: {
        accessKeyId: config.s3.accessKey,
        secretAccessKey: config.s3.secretKey
      },
      forcePathStyle: true
    })
  }
  return s3
}
