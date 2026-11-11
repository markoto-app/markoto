import type { Page, TestInfo } from '@playwright/test'
import { computeStripeSig } from '../../integration/setup/stripeHelpers'

// Stripe in flow tests. Real Stripe Checkout / the Customer Portal are
// hosted pages on another origin that a flow can't (and shouldn't)
// drive. Flows click the real button, these helpers keep the browser on
// markoto, and the webhook Stripe would send is posted directly — so the
// payoff (plan active, seats changed) is real.

/** The flow stack's webhook secret (`scripts/flows-ephemeral.ts`). */
const FLOWS_WEBHOOK_SECRET = 'whsec_test_flows'

/**
 * Keep the page on the app's origin: cross-origin `location.href`
 * writes are dropped (logged to the console) and cross-origin requests
 * answered with an empty page. Install BEFORE the first `page.goto`.
 */
export async function stayOnApp(page: Page, testInfo: TestInfo): Promise<void> {
  await page.addInitScript(() => {
    const proto = Object.getPrototypeOf(window.location)
    const desc = Object.getOwnPropertyDescriptor(proto, 'href')
    if (!desc?.set) return
    const sameOrigin = window.location.origin
    Object.defineProperty(window.location, 'href', {
      configurable: true,
      get: desc.get,
      set: (v: string) => {
        let crossOrigin: boolean
        try {
          crossOrigin = new URL(v, sameOrigin).origin !== sameOrigin
        } catch {
          crossOrigin = false
        }
        if (crossOrigin) {
          console.log('[test-stub] Cross-origin redirect intercepted:', v)
          return
        }
        desc.set!.call(window.location, v)
      }
    })
  })
  const appUrl = new URL(testInfo.project.use.baseURL ?? 'http://markoto.localhost:3001')
  const appOrigins = new Set([
    appUrl.origin,
    `${appUrl.protocol}//localhost:${appUrl.port}`,
    `${appUrl.protocol}//127.0.0.1:${appUrl.port}`
  ])
  await page.route('**/*', async (route) => {
    try {
      if (!appOrigins.has(new URL(route.request().url()).origin)) {
        await route.fulfill({ status: 200, body: '', contentType: 'text/html' })
        return
      }
    } catch { /* malformed URL — let it through */ }
    await route.continue()
  })
}

/** POST a Stripe event to the app's webhook, signed like Stripe would. */
export async function postStripeEvent(page: Page, event: Record<string, unknown>): Promise<number> {
  const body = JSON.stringify(event)
  const res = await page.request.post('/api/webhooks/stripe', {
    headers: { 'stripe-signature': computeStripeSig(body, FLOWS_WEBHOOK_SECRET), 'content-type': 'application/json' },
    data: body
  })
  return res.status()
}

/** A `customer.subscription.updated` event for one subscription item. */
export function subscriptionUpdatedEvent(args: {
  customer: string
  subscription: string
  priceId: string
  quantity: number
  status?: string
}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000)
  return {
    id: `evt_flow_sub_${args.subscription}_${Date.now()}`,
    object: 'event',
    api_version: '2025-01-27.acacia',
    created: now,
    livemode: false,
    type: 'customer.subscription.updated',
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    data: {
      object: {
        id: args.subscription,
        object: 'subscription',
        customer: args.customer,
        status: args.status ?? 'active',
        items: {
          data: [{
            id: `si_${args.subscription}`,
            quantity: args.quantity,
            price: { id: args.priceId, object: 'price' },
            current_period_start: now,
            current_period_end: now + 30 * 24 * 3600
          }]
        }
      }
    }
  }
}

// A paid credit top-up's `checkout.session.completed`.
export function topupCompletedEvent(args: {
  subjectType: 'user' | 'workspace'
  subjectId: string
  pack: '10' | '25' | '50'
  customer?: string
  currency?: 'eur' | 'chf'
}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000)
  const pi = `pi_flow_${args.subjectId}_${Date.now()}`
  return {
    id: `evt_flow_topup_${pi}`,
    object: 'event',
    api_version: '2025-01-27.acacia',
    created: now,
    livemode: false,
    type: 'checkout.session.completed',
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    data: {
      object: {
        id: `cs_${pi}`,
        object: 'checkout.session',
        mode: 'payment',
        payment_status: 'paid',
        payment_intent: pi,
        customer: args.customer ?? null,
        currency: args.currency ?? 'eur',
        amount_total: Number(args.pack) * 100,
        client_reference_id: args.subjectType === 'user' ? args.subjectId : `workspace:${args.subjectId}`,
        metadata: { kind: 'topup', pack: args.pack, subject_type: args.subjectType, subject_id: args.subjectId }
      }
    }
  }
}
