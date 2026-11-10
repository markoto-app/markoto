import type { H3Event } from 'h3'
import type { PublishedPageRow } from '../../repos/publishedPages'
import { buildPublishedPageHtml, publishedPageCsp } from './pageHtml'
import { publicBaseUrl, publishedPageUrl } from './access'
import { legalSurfacesEnabled } from '../instanceConfig'
import { emailLinkBaseUrl } from '../siteUrl'
import { NOINDEX_VALUE } from '../robots'
import { customDomainUrlForPage } from '../customDomains/routing'
import { resolveSiteIndexable } from '~~/shared/config/instance'

// Answer a request for a published page (WP13) — on the instance at
// `/p/<slug>` or at the root of a verified custom domain (`pageUrl`).
export async function sendPublishedPage(event: H3Event, page: PublishedPageRow, pageUrl?: string): Promise<string> {
  const base = publicBaseUrl(event)
  // A page shown on a custom domain names that domain as its canonical
  // address, also when opened at /p/<slug>.
  const url = pageUrl ?? await customDomainUrlForPage(page.id) ?? publishedPageUrl(base, page.slug)
  const indexable = page.indexable && resolveSiteIndexable(process.env)
  // The report form lives on the instance. On a custom domain the request
  // origin is the customer's host, so only a configured site URL will do.
  const reportBase = pageUrl ? emailLinkBaseUrl(useRuntimeConfig(event).siteUrl) : base
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
