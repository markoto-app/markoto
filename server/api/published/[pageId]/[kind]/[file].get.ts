import { GetObjectCommand } from '@aws-sdk/client-s3'
import { publishedPageExists } from '../../../../repos/publishedPages'
import { publishedObjectKey } from '../../../../utils/publish/snapshotAssets'
import { PUBLISHED_FILE_RE, PUBLISHED_PAGE_ID_RE } from '~~/shared/config/publish'

// GET /api/published/:pageId/(files|brand)/:file — an image or font of a
// published web page (WP13): the copy made when it was published, served
// only while the page exists. Public, like the page. Streamed by the app
// (no presigned redirect) so the page's CSP stays `'self'`, also on a
// custom domain.

const CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  woff2: 'font/woff2',
  woff: 'font/woff',
  ttf: 'font/ttf'
}

export default defineEventHandler(async (event) => {
  const pageId = getRouterParam(event, 'pageId') ?? ''
  const kind = getRouterParam(event, 'kind') ?? ''
  const file = getRouterParam(event, 'file') ?? ''
  if (!PUBLISHED_PAGE_ID_RE.test(pageId) || (kind !== 'files' && kind !== 'brand') || !PUBLISHED_FILE_RE.test(file)) {
    throw createError({ statusCode: 404, message: 'Not found' })
  }
  if (!await publishedPageExists(pageId)) throw createError({ statusCode: 404, message: 'Not found' })
  let bytes: Uint8Array
  try {
    const res = await useS3Client().send(new GetObjectCommand({ Bucket: useRuntimeConfig().s3.bucket, Key: publishedObjectKey(pageId, kind, file) }))
    bytes = await res.Body!.transformToByteArray()
  } catch {
    throw createError({ statusCode: 404, message: 'Not found' })
  }
  setHeader(event, 'content-type', CONTENT_TYPES[file.slice(file.lastIndexOf('.') + 1).toLowerCase()] ?? 'application/octet-stream')
  setHeader(event, 'content-length', bytes.byteLength)
  setHeader(event, 'x-content-type-options', 'nosniff')
  // Short: an unpublished page's files should stop loading soon.
  setHeader(event, 'cache-control', 'public, max-age=300')
  setHeader(event, 'access-control-allow-origin', '*')
  setHeader(event, 'cross-origin-resource-policy', 'cross-origin')
  setHeader(event, 'x-robots-tag', 'noindex')
  return bytes
})
