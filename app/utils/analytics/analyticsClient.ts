// The browser side of the cookieless analytics (docs/operations-analytics.md).
//
// Plain module state, created once per tab by `app/plugins/analytics.client.ts`:
// nothing is written to cookies or web storage, and nothing survives a reload.
// Events go to a same-origin endpoint (`/a/api/send`, routed to the
// self-hosted Umami by Traefik), never to a third party. Pure enough to test
// with a fake `fetch` and `window`.

import { attributionFromQuery, searchToQuery, type Attribution, type ClickId } from '~~/shared/analytics/attribution'
import { buildCollectPayload, trackablePath } from '~~/shared/analytics/pages'
import type { AnalyticsEventData, AnalyticsEventName, ResolvedEvent } from '~~/shared/analytics/events'

export interface AnalyticsConfig {
  websiteId: string
  endpoint: string
  adsConversions: boolean
}

export interface AnalyticsEnv {
  fetch: typeof fetch
  location: { hostname: string, search: string }
  language: string
  screen: string
  title: () => string
  referrer: string
}

export interface AnalyticsClient {
  /** Page view of `path` (ignored for paths that are not counted). */
  pageview: (path: string) => void
  /** A named event; `path` is the current route (reduced to a counted path or a placeholder). */
  track: <N extends AnalyticsEventName>(name: N, data: N extends keyof AnalyticsEventData ? AnalyticsEventData[N] : never, path: string) => void
  trackResolved: (event: ResolvedEvent, path: string) => void
  /** The Google Ads click id of this visit, when conversion tracking is on. */
  clickId: () => ClickId | null
  attribution: () => Attribution
}

const NOOP: AnalyticsClient = {
  pageview: () => {},
  track: () => {},
  trackResolved: () => {},
  clickId: () => null,
  attribution: () => ({ clickId: null, utm: {} })
}

export function createAnalyticsClient(config: AnalyticsConfig, env: AnalyticsEnv, optedOut: boolean): AnalyticsClient {
  // A visitor who opted out (GPC / DNT) sends nothing and keeps no click id.
  if (optedOut) return NOOP

  const landing = attributionFromQuery(searchToQuery(env.location.search))
  const attribution: Attribution = {
    utm: landing.utm,
    clickId: config.adsConversions ? landing.clickId : null
  }
  const sending = Boolean(config.websiteId)
  // Umami's session token from its last answer: skips its session lookup.
  let cacheToken: string | null = null
  let lastPageview: string | null = null

  function send(path: string, event?: ResolvedEvent): void {
    if (!sending) return
    const body = buildCollectPayload({
      websiteId: config.websiteId,
      hostname: env.location.hostname,
      language: env.language,
      screen: env.screen,
      path,
      title: env.title(),
      referrer: env.referrer,
      utm: attribution.utm
    }, event)
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (cacheToken) headers['x-umami-cache'] = cacheToken
    // keepalive: an event fired by a click that navigates away still arrives.
    env.fetch(config.endpoint, { method: 'POST', body: JSON.stringify(body), headers, keepalive: true, credentials: 'omit' })
      .then(async (res) => {
        if (!res.ok) return
        const answer = await res.json().catch(() => null) as { cache?: unknown } | null
        if (typeof answer?.cache === 'string') cacheToken = answer.cache
      })
      .catch(() => {})
  }

  return {
    pageview(path) {
      const counted = trackablePath(path)
      // One view per path change (a query-only navigation is the same page).
      if (!counted || counted === lastPageview) return
      lastPageview = counted
      send(path)
    },
    track(name, data, path) {
      const d = data as Record<string, string | number | boolean> | undefined
      send(path, { name, ...(d && Object.keys(d).length > 0 ? { data: d } : {}) })
    },
    trackResolved(event, path) {
      send(path, event)
    },
    clickId: () => attribution.clickId,
    attribution: () => attribution
  }
}

let client: AnalyticsClient = NOOP

export function setAnalyticsClient(c: AnalyticsClient): void {
  client = c
}

/** The tab's analytics client (a no-op on the server, when off, or after an opt-out). */
export function analyticsClient(): AnalyticsClient {
  return client
}
