import type { H3Event } from 'h3'
import { emailLinkBaseUrl } from '../platform/siteUrl'
import { publishedPageAddress } from './pagesHost'
import type { PublishedPageSummary } from '../../repos/publishedPages'

// Published-page addresses and the publish endpoints' response. Who may
// publish (owner + workspace admins: `allow.doc('manage')`) is declared by
// the routes themselves.

/** The instance origin published-page links use: NUXT_SITE_URL, else the request's. */
export function publicBaseUrl(event: H3Event): string {
  return emailLinkBaseUrl(useRuntimeConfig(event).siteUrl) ?? getRequestURL(event).origin
}

/** Address of a page at `/p/<slug>`: on the pages host when configured, else on the instance. */
export function publishedPageUrl(event: H3Event, slug: string): string {
  return publishedPageAddress(slug, publicBaseUrl(event))
}

export function publishView(event: H3Event, page: PublishedPageSummary | null) {
  if (!page) return { published: false as const, page: null }
  return {
    published: true as const,
    page: {
      slug: page.slug,
      url: publishedPageUrl(event, page.slug),
      indexable: page.indexable,
      publishedAt: page.publishedAt.toISOString(),
      updatedAt: page.updatedAt.toISOString()
    }
  }
}
