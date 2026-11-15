import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3'

/**
 * Creates the test stack's bucket if it isn't there yet. SeaweedFS makes a
 * bucket on its first upload; until then every listing (the orphan sweep 30 s
 * after boot) fails with NoSuchBucket and fills the server log.
 */
export async function ensureBucket(opts: { endpoint: string, accessKey: string, secretKey: string, bucket: string }): Promise<void> {
  const s3 = new S3Client({
    endpoint: opts.endpoint,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: opts.accessKey, secretAccessKey: opts.secretKey }
  })
  try {
    await s3.send(new CreateBucketCommand({ Bucket: opts.bucket }))
  } catch (e) {
    const name = (e as { name?: string }).name
    if (name !== 'BucketAlreadyOwnedByYou' && name !== 'BucketAlreadyExists') throw e
  } finally {
    s3.destroy()
  }
}
