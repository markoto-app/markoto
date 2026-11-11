import { GetObjectCommand } from '@aws-sdk/client-s3'
import { publishedPageExists } from '../../../../repos/publishedPages'
import { publishedObjectKey } from '../../../../utils/publish/snapshotAssets'
import { PUBLISHED_FILE_RE, PUBLISHED_PAGE_ID_RE } from '~~/shared/config/publish'

// GET /api/published/:pageId/(files|brand)/:file: an image or font of a
// published web page (the copy made at publish time), served only while the
// page exists. Public, like the page. Streamed by the app, not presigned, so
// the page's CSP stays `'self'` also on a custom domain; piped from S3, never
// buffered, since a page can reference many files of up to 10 MB each.

/** Per client (/64 for IPv6) and minute; a page view loads every image and font of the page. */
export const PUBLISHED_FILE_RATE_PER_MINUTE = 300

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
  if (!(await checkRateLimit('published-file', getClientRateLimitKey(event), PUBLISHED_FILE_RATE_PER_MINUTE, 60_000))) {
    throw createError({ statusCode: 429, message: 'Too many requests. Try again in a minute.', data: { code: 'published/rate-limited', messageKey: 'error.rateLimited' } })
  }
  if (!await publishedPageExists(pageId)) throw createError({ statusCode: 404, message: 'Not found' })
  let body: ReadableStream
  let length: number | undefined
  try {
    const res = await useS3Client().send(new GetObjectCommand({ Bucket: useRuntimeConfig().s3.bucket, Key: publishedObjectKey(pageId, kind, file) }))
    if (!res.Body) throw new Error('empty body')
    body = res.Body.transformToWebStream()
    length = res.ContentLength
  } catch {
    throw createError({ statusCode: 404, message: 'Not found' })
  }
  setHeader(event, 'content-type', CONTENT_TYPES[file.slice(file.lastIndexOf('.') + 1).toLowerCase()] ?? 'application/octet-stream')
  if (length !== undefined) setHeader(event, 'content-length', length)
  setHeader(event, 'x-content-type-options', 'nosniff')
  // Short: an unpublished page's files should stop loading soon.
  setHeader(event, 'cache-control', 'public, max-age=300')
  // Loaded only by the page itself, from the host it is served on (pages host,
  // custom domain, or the instance): same-origin, also for fonts (CORS mode).
  // No other site may embed them.
  setHeader(event, 'cross-origin-resource-policy', 'same-origin')
  setHeader(event, 'x-robots-tag', 'noindex')
  return body
})
