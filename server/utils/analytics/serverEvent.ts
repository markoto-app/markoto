import type { H3Event } from 'h3'
import { useEnv } from '~~/shared/env/load'
import { ANALYTICS_EVENTS } from '~~/shared/analytics/events'

// Server-side analytics counts (docs/operations-analytics.md). Published
// pages carry no script at all (their CSP has no script-src), so their views
// are counted here: one aggregate `published_page_view` per request, sent
// to Umami in the network with a fixed placeholder address and user agent.
// No visitor address, user agent, referrer or page slug leaves: Umami sees
// one anonymous "server" visitor, so only the count is meaningful.
// Fire and forget; never slows down or fails the page.

const SERVER_UA = 'Mozilla/5.0 (X11; Linux x86_64) markoto-server/1.0'
const BOT_UA = /bot|crawl|spider|slurp|preview|monitor|curl|wget|headless/i

/** The body Umami receives for a published-page view. */
export function publishedPageViewBody(websiteId: string, hostname: string) {
  return {
    type: 'event' as const,
    payload: {
      website: websiteId,
      hostname,
      url: '/p',
      name: ANALYTICS_EVENTS.publishedPageView,
      // Loopback: Umami derives no location and one fixed session from it.
      ip: '127.0.0.1',
      language: '',
      screen: ''
    }
  }
}

export function countPublishedPageView(event: H3Event): void {
  const { websiteId, internalUrl } = useEnv().analytics
  if (!websiteId || !internalUrl) return
  if (BOT_UA.test(getRequestHeader(event, 'user-agent') ?? '')) return
  const siteUrl = useEnv().core.siteUrl
  const hostname = siteUrl ? new URL(siteUrl).hostname : 'localhost'
  void fetch(new URL('/api/send', internalUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': SERVER_UA },
    body: JSON.stringify(publishedPageViewBody(websiteId, hostname)),
    signal: AbortSignal.timeout(3000)
  }).catch(() => {})
}
