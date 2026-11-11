import { S3Client } from '@aws-sdk/client-s3'

let s3: S3Client | null = null
let presignS3: S3Client | null = null

function buildClient(endpoint: string): S3Client {
  const config = useRuntimeConfig()
  return new S3Client({
    endpoint,
    region: 'us-east-1',
    credentials: {
      accessKeyId: config.s3.accessKey,
      secretAccessKey: config.s3.secretKey
    },
    forcePathStyle: true,
    // Only send / verify checksums when an operation requires them. The SDK
    // default (WHEN_SUPPORTED, since @aws-sdk 3.729) adds a CRC32 to every
    // PutObject, and in a PRESIGNED PUT that checksum is computed over the
    // empty body at signing time (`x-amz-checksum-crc32=AAAAAA==`), so the
    // browser's real upload is rejected with 400 BadDigest. WHEN_REQUIRED is
    // what S3-compatible backends (OVH, SeaweedFS) expect.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED'
  })
}

/** Server-to-S3 client (uploads, HEAD, delete, list) on `NUXT_S3_ENDPOINT`. */
export function useS3Client(): S3Client {
  if (!s3) s3 = buildClient(useRuntimeConfig().s3.endpoint)
  return s3
}

/**
 * Client for presigned URLs that a BROWSER follows (image PUT/GET, knowledge
 * uploads, PDF + data-export downloads).
 *
 * A SigV4 signature covers the `Host` header, so the URL must be signed for
 * the host the browser actually talks to. When the app reaches S3 on an
 * internal address the browser can't resolve — the self-host compose's
 * `http://seaweedfs:8333`, published to browsers through Traefik under the
 * public origin — `NUXT_S3_PUBLIC_ENDPOINT` names that public base URL.
 * Unset (hosted: external S3 reachable under the same URL from both sides)
 * it is the regular client.
 */
export function usePresignS3Client(): S3Client {
  const publicEndpoint = useRuntimeConfig().s3.publicEndpoint
  if (!publicEndpoint) return useS3Client()
  if (!presignS3) presignS3 = buildClient(publicEndpoint)
  return presignS3
}
