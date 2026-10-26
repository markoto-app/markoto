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

// SSE-S3 on every render artefact (defense-in-depth) — see docs/S3-SETUP.md.
// SeaweedFS (dev + test S3 backend) does NOT support SSE-S3 and returns an
// opaque `InternalError` on the encryption header, which surfaced as a
// generic "Renderer 500" on every PDF export in those envs. Gate the header
// so those backends can disable it (S3_SSE=none) while prod (OVH) keeps the
// default. Unset → AES256 (prod-safe default).
const sseValue = process.env.S3_SSE ?? 'AES256'
const useSse = sseValue !== '' && sseValue.toLowerCase() !== 'none'

export const s3 = new S3Client({
  endpoint,
  region: 'us-east-1',
  credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
  forcePathStyle: true,
  // Checksums only when an operation requires them — the pre-@aws-sdk-3.729
  // request shape, which every S3-compatible backend (OVH, SeaweedFS)
  // accepts. Same setting as the app's client (server/utils/s3.ts).
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED'
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
    // drop encryption. Omitted when S3_SSE=none (SeaweedFS dev/test).
    ...(useSse ? { ServerSideEncryption: sseValue as 'AES256' } : {})
  }))
}
