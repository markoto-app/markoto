import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'

// Reads env once at module load. The renderer is a single-process container
// — env is fixed for its lifetime; no need for the lazy-singleton dance the
// app's S3 client does (which has to wait for nuxt runtime config).
const endpoint = required('S3_ENDPOINT')
const accessKey = required('S3_ACCESS_KEY')
const secretKey = required('S3_SECRET_KEY')
export const BUCKET = required('S3_BUCKET')

function required(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`[renderer] ${name} environment variable is required`)
  return v
}

export const s3 = new S3Client({
  endpoint,
  region: 'us-east-1',
  credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
  forcePathStyle: true
})

export async function putBytes(
  key: string,
  bytes: Uint8Array | Buffer,
  contentType: string
): Promise<void> {
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: bytes,
    ContentType: contentType,
    // Defense-in-depth: explicit SSE-S3 on every render artefact (PDF,
    // page PNGs, manifest). Belt-and-braces alongside the bucket-level
    // default — see docs/S3-SETUP.md §6. Direct server-side PUTs set
    // the header per-object so a misconfigured bucket can't silently
    // drop encryption.
    ServerSideEncryption: 'AES256'
  }))
}
