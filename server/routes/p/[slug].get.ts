import { getPublishedPageBySlug } from '../../repos/publishedPages'
import { sendPublishedPage } from '../../utils/publish/servePage'
import { PUBLISH_SLUG_RE } from '~~/shared/config/publish'
import { publishedPageParams } from '~~/shared/api/platform'
import { countPublishedPageView } from '../../utils/analytics/serverEvent'

// GET /p/:slug: a document published as a web page. A static
// snapshot; the document itself stays as private as it is. Public and
// sessionless: on the pages host and custom domains a request hook
// (plugins/00-public-page-host.ts) strips cookies, so the policy must never
// read the session.
export default defineApiHandler({
  access: allow.public('A published web page is public by design; only the snapshot made at publish time is served'),
  params: publishedPageParams,
  handler: async ({ event, params }) => {
    const slug = params.slug
    const page = PUBLISH_SLUG_RE.test(slug) ? await getPublishedPageBySlug(slug) : null
    if (!page) {
      setHeader(event, 'cache-control', 'no-store')
      throw apiError('published/not-found')
    }
    // Aggregate view count only (no visitor data, no slug).
    countPublishedPageView(event)
    return sendPublishedPage(event, page)
  }
})
