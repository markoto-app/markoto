// Cookieless analytics + ad-click attribution (docs/operations-analytics.md).
//
// Off unless the instance sets NUXT_PUBLIC_ANALYTICS_WEBSITE_ID (page views
// and events) and / or NUXT_PUBLIC_ANALYTICS_ADS_CONVERSIONS (the Google
// Ads click id travels with a conversion request). Nothing is stored in the
// browser; Global Privacy Control and Do Not Track turn both off.
//
// What it does:
//   - page views of the public pages only (`trackablePath`: never /d, /p, …);
//   - the click events of `shared/analytics/events.ts#resolveClickEvent`,
//     from one delegated listener (keyed on the e2e test ids);
//   - sign-in links: `signup_started`, and the click id appended to the link
//     so the server can attribute a new account (server/utils/analytics/);
//   - `signup_completed` when the server redirects a NEW account to
//     `/?signed_up=<provider>` (the parameter is removed again);
//   - product-tour scroll depth.
// The click id is also removed from the address bar, so a copied link
// doesn't carry it.

import { createAnalyticsClient, setAnalyticsClient } from '~/utils/analytics/analyticsClient'
import { ANALYTICS_EVENTS, loginProviderOfPath, newTourDepths, resolveClickEvent } from '~~/shared/analytics/events'
import { CLICK_ID_PARAMS, clickIdQuery } from '~~/shared/analytics/attribution'
import { optedOutOfTracking } from '~~/shared/analytics/pages'

export default defineNuxtPlugin((nuxtApp) => {
  const config = useRuntimeConfig().public.analytics
  if (!config?.websiteId && !config?.adsConversions) return

  const client = createAnalyticsClient(
    { websiteId: config.websiteId ?? '', endpoint: config.endpoint || '/a/api/send', adsConversions: Boolean(config.adsConversions) },
    {
      fetch: globalThis.fetch.bind(globalThis),
      location: { hostname: location.hostname, search: location.search },
      language: navigator.language || '',
      screen: `${screen.width}x${screen.height}`,
      title: () => document.title,
      referrer: document.referrer
    },
    optedOutOfTracking(navigator, window as unknown as { doNotTrack?: unknown })
  )
  setAnalyticsClient(client)

  const router = useRouter()
  const route = useRoute()

  // Drop the click id from the address bar (kept in memory above).
  const url = new URL(location.href)
  if (CLICK_ID_PARAMS.some(p => url.searchParams.has(p))) {
    for (const p of CLICK_ID_PARAMS) url.searchParams.delete(p)
    history.replaceState(history.state, '', url.pathname + url.search + url.hash)
  }

  const landingClick = client.attribution().clickId
  nuxtApp.hooks.hookOnce('app:suspense:resolve', () => {
    client.pageview(route.path)
    if (landingClick) client.track(ANALYTICS_EVENTS.adLanding, { network: 'google', id_type: landingClick.type }, route.path)
    const signedUp = route.query.signed_up
    if (signedUp === 'github' || signedUp === 'google' || signedUp === 'oidc') {
      client.track(ANALYTICS_EVENTS.signupCompleted, { provider: signedUp }, route.path)
      void router.replace({ query: { ...route.query, signed_up: undefined } })
    }
  })
  router.afterEach((to, from) => {
    if (to.path !== from.path) client.pageview(to.path)
  })

  // Clicks: capture phase, so a link's href can still be changed before the
  // browser follows it.
  document.addEventListener('click', (e) => {
    const target = e.target instanceof Element ? e.target : null
    if (!target) return
    const testids: string[] = []
    for (let el: Element | null = target; el; el = el.parentElement) {
      const id = el.getAttribute('data-testid')
      if (id) testids.push(id)
    }
    const event = resolveClickEvent(testids)
    if (event) client.trackResolved(event, route.path)

    const link = target.closest('a[href]')
    if (!(link instanceof HTMLAnchorElement)) return
    const href = new URL(link.href, location.href)
    if (href.origin !== location.origin) return
    const provider = loginProviderOfPath(href.pathname)
    if (!provider) return
    client.track(ANALYTICS_EVENTS.signupStarted, { provider }, route.path)
    for (const [k, v] of Object.entries(clickIdQuery(client.clickId()))) href.searchParams.set(k, v)
    link.href = href.toString()
  }, { capture: true })

  // Product-tour scroll depth, once per mark and page view.
  let sentDepths = new Set<number>()
  router.afterEach(() => {
    sentDepths = new Set()
  })
  window.addEventListener('scroll', () => {
    if (route.path !== '/' || !document.querySelector('[data-testid="product-tour"]')) return
    const max = document.documentElement.scrollHeight - window.innerHeight
    if (max <= 0) return
    for (const depth of newTourDepths((window.scrollY / max) * 100, sentDepths)) {
      sentDepths.add(depth)
      client.track(ANALYTICS_EVENTS.tourScrolled, { depth }, route.path)
    }
  }, { passive: true })
})
