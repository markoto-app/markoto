// The browser side of the cookieless analytics (docs/SELF-HOSTING.md#analytics-optional).
//
// Plain module state, created once per tab by `app/plugins/analytics.client.ts`:
// nothing is written to cookies or web storage, and nothing survives a reload.
// Events go to a same-origin endpoint (`/a/api/send`, routed to the
// self-hosted Umami by Traefik), never to a third party. Pure enough to test
// with a fake `fetch` and `window`.

import { attributionFromQuery, searchToQuery, type Attribution, type ClickId } from '~~/shared/analytics/attribution'
import { buildCollectPayload, trackablePath } from '~~/shared/analytics/pages'
import { SOURCE_TAGGED_EVENTS, type AnalyticsEventData, type AnalyticsEventName, type ResolvedEvent } from '~~/shared/analytics/events'
import { acquisitionSourceOf, type AcquisitionSource } from '~~/shared/analytics/acquisition'

export interface AnalyticsConfig {
  websiteId: string
  endpoint: string
  adsConversions: boolean
  /**
   * Signed in at page load: the referrer is then not a source (after a
   * sign-in it is the provider's page); only an explicit `ref` /
   * `utm_source` counts.
   */
  signedIn?: boolean
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
  /** The visit's acquisition source (null = direct, or statistics off). */
  source: () => AcquisitionSource | null
  /** Set the source the server knows better (the account's, after a sign-up). */
  setSource: (source: AcquisitionSource | null) => void
}

const NOOP: AnalyticsClient = {
  pageview: () => {},
  track: () => {},
  trackResolved: () => {},
  clickId: () => null,
  attribution: () => ({ clickId: null, utm: {} }),
  source: () => null,
  setSource: () => {}
}

export function createAnalyticsClient(config: AnalyticsConfig, env: AnalyticsEnv, optedOut: boolean): AnalyticsClient {
  // A visitor who opted out (GPC / DNT) sends nothing and keeps no click id.
  if (optedOut) return NOOP

  const query = searchToQuery(env.location.search)
  const landing = attributionFromQuery(query)
  const attribution: Attribution = {
    utm: landing.utm,
    clickId: config.adsConversions ? landing.clickId : null
  }
  const sending = Boolean(config.websiteId)
  // The acquisition source belongs to the statistics: kept only where they are on.
  let source: AcquisitionSource | null = sending
    ? acquisitionSourceOf({ query, referrer: config.signedIn ? '' : env.referrer, ownHost: env.location.hostname })
    : null
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
      utm: attribution.utm,
      ref: source
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
      send(path, withSource({ name, ...(data && Object.keys(data).length > 0 ? { data: data as Record<string, string | number | boolean> } : {}) }))
    },
    trackResolved(event, path) {
      send(path, withSource(event))
    },
    clickId: () => attribution.clickId,
    attribution: () => attribution,
    source: () => source,
    setSource(next) {
      source = next
    }
  }

  /** A funnel event with the visit's source as `ref` (`direct` when none). */
  function withSource(event: ResolvedEvent): ResolvedEvent {
    if (!SOURCE_TAGGED_EVENTS.has(event.name)) return event
    return { ...event, data: { ...event.data, ref: source ?? 'direct' } }
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
