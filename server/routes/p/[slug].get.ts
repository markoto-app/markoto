import { getPublishedPageBySlug } from '../../repos/publishedPages'
import { sendPublishedPage } from '../../utils/publish/servePage'
import { PUBLISH_SLUG_RE } from '~~/shared/config/publish'

// GET /p/:slug — a document published as a web page (WP13). A static
// snapshot; the document itself stays as private as it is.
export default defineEventHandler(async (event) => {
  const slug = getRouterParam(event, 'slug') ?? ''
  const page = PUBLISH_SLUG_RE.test(slug) ? await getPublishedPageBySlug(slug) : null
  if (!page) {
    setHeader(event, 'cache-control', 'no-store')
    throw createError({ statusCode: 404, message: 'This page does not exist or is no longer published.' })
  }
  return sendPublishedPage(event, page)
})
