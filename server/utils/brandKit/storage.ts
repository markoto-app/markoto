import { DeleteObjectsCommand, GetObjectCommand, NoSuchKey, PutObjectCommand } from '@aws-sdk/client-s3'
import type { H3Event } from 'h3'
import { BRAND_ASSET_CONTENT_TYPES, type BrandAssetFormat } from '~~/shared/config/brandKit'
import { listBrandAssetKeys, type BrandAssetRow } from '../../repos/brandAssets'

// S3 side of the brand kit (WP10). Objects at
// `workspaces/{wsId}/brand/{id}.{format}`. The app streams them itself
// (no presigned redirect): fonts load in CORS mode from the sandboxed,
// opaque-origin preview iframe, and an S3 redirect would need CORS on the
// bucket. Files are small (≤ 10 MB fonts, ≤ 5 MB images).

export function brandAssetKey(workspaceId: string, id: string, format: BrandAssetFormat): string {
  return `workspaces/${workspaceId}/brand/${id}.${format}`
}

export async function putBrandObject(key: string, bytes: Uint8Array, format: BrandAssetFormat): Promise<void> {
  await useS3Client().send(new PutObjectCommand({
    Bucket: useRuntimeConfig().s3.bucket,
    Key: key,
    Body: bytes,
    ContentType: BRAND_ASSET_CONTENT_TYPES[format]
  }))
}

/** Best-effort delete (a leftover object is unreachable: every route checks the row first). */
export async function deleteBrandObjects(keys: string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000)
    try {
      await useS3Client().send(new DeleteObjectsCommand({
        Bucket: useRuntimeConfig().s3.bucket,
        Delete: { Objects: batch.map(Key => ({ Key })), Quiet: true }
      }))
    } catch (e) {
      console.warn(`[brandKit] deleting ${batch.length} brand objects failed:`, e instanceof Error ? e.message : e)
    }
  }
}

/** Workspace deletion: read the keys BEFORE the rows cascade away. */
export async function collectBrandObjectKeys(workspaceId: string): Promise<string[]> {
  return listBrandAssetKeys(workspaceId)
}

/**
 * Stream one asset. `crossOrigin`: the document route, read by the
 * opaque-origin preview iframe (fonts in CORS mode, images cross-site) —
 * `Access-Control-Allow-Origin: *` and CORP `cross-origin`; access rides
 * on the URL's token, never on credentials.
 */
export async function sendBrandAsset(event: H3Event, row: BrandAssetRow, opts: { crossOrigin: boolean }): Promise<Uint8Array> {
  let bytes: Uint8Array
  try {
    const res = await useS3Client().send(new GetObjectCommand({ Bucket: useRuntimeConfig().s3.bucket, Key: row.s3Key }))
    if (!res.Body) throw new NoSuchKey({ message: 'empty body', $metadata: {} })
    bytes = await res.Body.transformToByteArray()
  } catch (e) {
    // The row exists but the object doesn't (lost, or deleted under us):
    // the file is gone, not a server fault.
    if (e instanceof NoSuchKey) throw createError({ statusCode: 404, message: 'File not found' })
    throw e
  }
  setHeader(event, 'content-type', BRAND_ASSET_CONTENT_TYPES[row.format])
  setHeader(event, 'content-length', bytes.byteLength)
  setHeader(event, 'x-content-type-options', 'nosniff')
  // Private: the URL may carry a viewer's token; assets are immutable per
  // id (a re-upload gets a new id), so an hour of browser cache is safe.
  setHeader(event, 'cache-control', 'private, max-age=3600, immutable')
  if (opts.crossOrigin) {
    setHeader(event, 'access-control-allow-origin', '*')
    setHeader(event, 'cross-origin-resource-policy', 'cross-origin')
  }
  return bytes
}
