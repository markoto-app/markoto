import type { H3Event } from 'h3'
import type { PublishedPageRow } from '../../repos/publishedPages'
import { buildPublishedPageHtml, publishedPageCsp } from './pageHtml'
import { publicBaseUrl, publishedPageUrl } from './access'
import { publishPagesSettings } from './pagesHost'
import { legalSurfacesEnabled } from '../instanceConfig'
import { emailLinkBaseUrl } from '../siteUrl'
import { NOINDEX_VALUE } from '../robots'
import { customDomainUrlForPage } from '../customDomains/routing'
import { resolveSiteIndexable } from '~~/shared/config/instance'

// Answer a request for a published page — at `/p/<slug>` (on the pages
// host when one is configured, else on the instance) or at the root of a
// verified custom domain (`pageUrl`).
export async function sendPublishedPage(event: H3Event, page: PublishedPageRow, pageUrl?: string): Promise<string> {
  // A page shown on a custom domain names that domain as its canonical
  // address, also when opened at /p/<slug>.
  const url = pageUrl ?? await customDomainUrlForPage(page.id) ?? publishedPageUrl(event, page.slug)
  const indexable = page.indexable && resolveSiteIndexable(process.env)
  // The report form lives on the app. On a custom domain or the pages
  // host the request origin is not the app's, so only the configured
  // site URL will do.
  const reportBase = pageUrl || publishPagesSettings() ? emailLinkBaseUrl(useRuntimeConfig(event).siteUrl) : publicBaseUrl(event)
  setHeader(event, 'content-type', 'text/html; charset=utf-8')
  // Overrides the app CSP the request hook set: no script at all here.
  setHeader(event, 'content-security-policy', publishedPageCsp())
  setHeader(event, 'x-content-type-options', 'nosniff')
  setHeader(event, 'referrer-policy', 'strict-origin-when-cross-origin')
  setHeader(event, 'cache-control', 'public, max-age=60')
  if (indexable) removeResponseHeader(event, 'x-robots-tag')
  else setHeader(event, 'x-robots-tag', NOINDEX_VALUE)
  return buildPublishedPageHtml({
    title: page.title,
    language: page.language,
    html: page.html,
    css: page.css,
    fontsImport: page.fontsImport,
    hljsUrl: page.hljsUrl,
    indexable,
    canonicalUrl: url,
    reportUrl: reportBase && legalSurfacesEnabled() ? `${reportBase}/legal/abuse?url=${encodeURIComponent(url)}` : null
  })
}
