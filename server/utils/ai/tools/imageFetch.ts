import { GetObjectCommand } from '@aws-sdk/client-s3'
import { useS3Client } from '../../storage/s3'
import { fetchExternalImage as fetchExternalImageGuarded, type ExternalImageResult } from '../../storage/externalImage'
import { MIB } from '~~/shared/config/units'
import { useEnv } from '~~/shared/env/load'

// Fetching an image for the model to see (`view_image`) — from this
// document's uploads in S3 or from an external URL behind the SSRF guard.
// Image generation reuses the external fetch for providers that answer
// with a URL.

// The model accepts a handful of image MIME types inline. Keep the
// allowlist aligned with what our upload pipeline emits plus what
// Mistral's vision model actually renders — reject anything else
// rather than gamble on model behavior.
const ALLOWED_IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/heic',
  'image/heif'
])

// 5 MiB cap: matches the upload flow's practical ceiling, keeps one turn's
// context footprint sane. Modern multimodal models inline up to ~20MB per
// part but a 20MB image on every turn quickly blows up prompt-caching
// economics.
const MAX_IMAGE_BYTES = 5 * MIB

// Extracts `{ docId, fileId }` from either a relative path
// (`/api/files/abc/def.png`) or an absolute URL pointing at our own
// /api/files endpoint. Returns null for anything else.
export function parseInternalFileRef(src: string): { docId: string, fileId: string } | null {
  const match = /\/api\/files\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+\.[A-Za-z0-9]+)(?:$|[?#])/.exec(src)
  if (!match) return null
  const [, docId, fileId] = match
  return docId && fileId ? { docId, fileId } : null
}

export async function fetchFromS3(docId: string, fileId: string): Promise<{ bytes: Uint8Array, mimeType: string } | { error: string }> {
  const s3 = useS3Client()
  const env = useEnv()
  try {
    const resp = await s3.send(new GetObjectCommand({
      Bucket: env.storage.bucket,
      Key: `docs/${docId}/${fileId}`
    }))
    const mimeType = resp.ContentType ?? 'application/octet-stream'
    if (!ALLOWED_IMAGE_TYPES.has(mimeType)) {
      return { error: `Unsupported image type "${mimeType}". Allowed: ${[...ALLOWED_IMAGE_TYPES].join(', ')}.` }
    }
    if (typeof resp.ContentLength === 'number' && resp.ContentLength > MAX_IMAGE_BYTES) {
      return { error: `Image is ${Math.round(resp.ContentLength / 1024)}KB, which exceeds the ${MAX_IMAGE_BYTES / MIB}MB limit for inlining.` }
    }
    if (!resp.Body) return { error: 'Image is empty.' }
    const bytes = await resp.Body.transformToByteArray()
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      return { error: `Image exceeded the ${MAX_IMAGE_BYTES / MIB}MB limit after fetch.` }
    }
    return { bytes, mimeType }
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error'
    return { error: `Failed to fetch image from storage: ${msg}` }
  }
}

/** `view_image` limits applied to external URLs (see `externalImage.ts`). */
export function fetchViewableExternalImage(url: string): Promise<ExternalImageResult> {
  return fetchExternalImageGuarded(url, { allowedTypes: ALLOWED_IMAGE_TYPES, maxBytes: MAX_IMAGE_BYTES })
}
