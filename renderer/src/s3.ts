import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { env } from './env'

// Env is fixed for the container's lifetime and validated at load (./env.ts).
const { endpoint, accessKey, secretKey, bucket: BUCKET } = env.storage

// SSE-S3 on every render artefact (defense-in-depth) — see docs/S3-SETUP.md.
// SeaweedFS (dev + test S3 backend) does NOT support SSE-S3 and returns an
// opaque `InternalError` on the encryption header, which surfaced as a
// generic "Renderer 500" on every PDF export in those envs. Gate the header
// so those backends can disable it (S3_SSE=none) while prod (OVH) keeps the
// default. Unset → AES256 (prod-safe default).
const useSse = env.storage.sse !== '' && env.storage.sse.toLowerCase() !== 'none'

const s3 = new S3Client({
  endpoint,
  region: 'us-east-1',
  credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
  forcePathStyle: true,
  // Checksums only when an operation requires them — the pre-@aws-sdk-3.729
  // request shape, which every S3-compatible backend (OVH, SeaweedFS)
  // accepts. Same setting as the app's client (server/utils/storage/s3.ts).
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
    ...(useSse ? { ServerSideEncryption: env.storage.sse as 'AES256' } : {})
  }))
}
