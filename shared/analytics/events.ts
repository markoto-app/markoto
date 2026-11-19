// Every analytics event markoto sends, in one place. Names are
// `object_action` in snake_case; data values are short enums or numbers,
// never free text, ids, emails, document titles or content.
// docs/SELF-HOSTING.md#analytics-optional lists them with the funnels built from them.

export const ANALYTICS_EVENTS = {
  /** The landing URL carried a Google Ads click id (the id itself is not sent). */
  adLanding: 'ad_landing',
  /** The product tour was scrolled past 25 / 50 / 75 / 100 %. */
  tourScrolled: 'tour_scrolled',
  /** A "Start writing" / "Open as a document" button. */
  startWritingClicked: 'start_writing_clicked',
  /** A plan card's call to action on /pricing. */
  pricingCtaClicked: 'pricing_cta_clicked',
  /** A paid plan's checkout button (billing on). */
  checkoutStarted: 'checkout_started',
  waitlistSubmitted: 'waitlist_submitted',
  waitlistConfirmed: 'waitlist_confirmed',
  /** A sign-in button (GitHub / Google / OIDC). */
  signupStarted: 'signup_started',
  /** Back from the provider with a NEW account (not a returning sign-in). */
  signupCompleted: 'signup_completed',
  docCreated: 'doc_created',
  /** First AI prompt of a page session. */
  aiFirstUse: 'ai_first_use',
  githubClicked: 'github_clicked',
  selfHostClicked: 'selfhost_clicked',
  /** Server-side count of published-page views: no visitor data, no slug. */
  publishedPageView: 'published_page_view'
} as const

export type AnalyticsEventName = typeof ANALYTICS_EVENTS[keyof typeof ANALYTICS_EVENTS]

export type Placement = 'header' | 'footer' | 'tour_hero' | 'tour_final' | 'content' | 'try_it' | 'pricing'
export type PricingPlan = 'anonymous' | 'free' | 'self_hosted' | 'pro' | 'team' | 'business'
export type LoginProviderName = 'github' | 'google' | 'oidc'

/** The data each event may carry. */
export interface AnalyticsEventData {
  ad_landing: { network: 'google', id_type: 'gclid' | 'gbraid' | 'wbraid' }
  tour_scrolled: { depth: 25 | 50 | 75 | 100 }
  start_writing_clicked: { placement: Placement }
  pricing_cta_clicked: { plan: PricingPlan, action: 'start' | 'sign_in' | 'waitlist' | 'self_host' | 'checkout' }
  checkout_started: { plan: PricingPlan }
  waitlist_submitted: Record<string, never>
  waitlist_confirmed: Record<string, never>
  signup_started: { provider: LoginProviderName }
  signup_completed: { provider: LoginProviderName }
  doc_created: { anonymous: boolean, source: 'dialog' | 'try_it' }
  ai_first_use: Record<string, never>
  github_clicked: { placement: Placement }
  selfhost_clicked: { placement: Placement }
  published_page_view: Record<string, never>
}

export interface ResolvedEvent {
  name: AnalyticsEventName
  data?: Record<string, string | number | boolean>
}

const PLANS = new Set<string>(['pro', 'team', 'business'])

/** Fixed `data-testid` → event. The test ids are the e2e suite's, so they are stable. */
const CLICK_TARGETS: Record<string, ResolvedEvent> = {
  'tour-start-writing': { name: ANALYTICS_EVENTS.startWritingClicked, data: { placement: 'tour_hero' } },
  'tour-final-start': { name: ANALYTICS_EVENTS.startWritingClicked, data: { placement: 'tour_final' } },
  'header-start-writing': { name: ANALYTICS_EVENTS.startWritingClicked, data: { placement: 'header' } },
  'marketing-start-writing': { name: ANALYTICS_EVENTS.startWritingClicked, data: { placement: 'content' } },
  'try-it-open': { name: ANALYTICS_EVENTS.startWritingClicked, data: { placement: 'try_it' } },
  'pricing-anon-cta': { name: ANALYTICS_EVENTS.pricingCtaClicked, data: { plan: 'anonymous', action: 'start' } },
  'pricing-free-sign-in': { name: ANALYTICS_EVENTS.pricingCtaClicked, data: { plan: 'free', action: 'sign_in' } },
  'pricing-self-hosted-cta': { name: ANALYTICS_EVENTS.pricingCtaClicked, data: { plan: 'self_hosted', action: 'self_host' } },
  'header-github-link': { name: ANALYTICS_EVENTS.githubClicked, data: { placement: 'header' } },
  'footer-github-link': { name: ANALYTICS_EVENTS.githubClicked, data: { placement: 'footer' } },
  'header-self-host-link': { name: ANALYTICS_EVENTS.selfHostClicked, data: { placement: 'header' } },
  'footer-self-host-link': { name: ANALYTICS_EVENTS.selfHostClicked, data: { placement: 'footer' } },
  'tour-self-host': { name: ANALYTICS_EVENTS.selfHostClicked, data: { placement: 'tour_final' } }
}

/**
 * The event a click stands for, from the `data-testid`s of the clicked
 * element and its ancestors (innermost first), or null.
 */
export function resolveClickEvent(testids: readonly string[]): ResolvedEvent | null {
  for (const [i, id] of testids.entries()) {
    const fixed = CLICK_TARGETS[id]
    if (fixed) return fixed
    const buyPlan = /^pricing-buy-([a-z]+)$/.exec(id)?.[1]
    if (buyPlan && PLANS.has(buyPlan)) return { name: ANALYTICS_EVENTS.checkoutStarted, data: { plan: buyPlan } }
    if (id === 'pricing-join-waitlist') {
      // The plan is the card the button sits in.
      const card = testids.slice(i + 1).map(t => /^pricing-tier-([a-z]+)$/.exec(t)?.[1]).find(p => p && PLANS.has(p))
      return { name: ANALYTICS_EVENTS.pricingCtaClicked, data: card ? { plan: card, action: 'waitlist' } : { action: 'waitlist' } }
    }
  }
  return null
}

const LOGIN_PATH = /^\/auth\/(github|google|oidc)$/

/** The provider of a sign-in link (`/auth/google`), or null. */
export function loginProviderOfPath(pathname: string): LoginProviderName | null {
  return (LOGIN_PATH.exec(pathname)?.[1] as LoginProviderName | undefined) ?? null
}

/** Scroll-depth marks of the product tour, in percent of the page. */
export const TOUR_DEPTHS = [25, 50, 75, 100] as const

/** The marks newly passed at `percent`, given those already sent. */
export function newTourDepths(percent: number, sent: ReadonlySet<number>): Array<typeof TOUR_DEPTHS[number]> {
  return TOUR_DEPTHS.filter(d => percent >= d - 0.5 && !sent.has(d))
}

/** A funnel step: a page path (exact) or an event name. */
export type FunnelStep = { path: string } | { event: AnalyticsEventName }

/**
 * The funnels to set up in Umami (Reports → Funnel). Steps are counted per
 * Umami session, which lasts one day at most (daily salt): a conversion on a
 * later day is attributed through the server-side click-id record instead.
 */
export const FUNNELS: Record<string, { title: string, steps: FunnelStep[] }> = {
  adToDocument: {
    title: 'Ad click to first document',
    steps: [{ event: ANALYTICS_EVENTS.adLanding }, { event: ANALYTICS_EVENTS.startWritingClicked }, { event: ANALYTICS_EVENTS.docCreated }]
  },
  landingToPaid: {
    title: 'Landing to paid-plan interest',
    steps: [{ path: '/' }, { path: '/pricing' }, { event: ANALYTICS_EVENTS.pricingCtaClicked }, { event: ANALYTICS_EVENTS.waitlistSubmitted }]
  },
  landingToActivation: {
    title: 'Landing to activated account',
    steps: [{ path: '/' }, { event: ANALYTICS_EVENTS.signupStarted }, { event: ANALYTICS_EVENTS.signupCompleted }, { event: ANALYTICS_EVENTS.docCreated }, { event: ANALYTICS_EVENTS.aiFirstUse }]
  }
}
