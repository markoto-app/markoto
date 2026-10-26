import { test, expect } from '../fixtures/flow'
import { computeStripeSig, loadStripeFixture } from '../../integration/setup/stripeHelpers'

// The flow-test stack uses its own webhook secret (set in
// `scripts/flows-ephemeral.ts` as `whsec_test_flows`). The integration
// stack's secret (`whsec_test_integration`) is different — using the
// helper's exported constant here would make the server reject the
// signature with 400. Hardcode the literal that matches the env the
// orchestrator wires in.
const FLOWS_WEBHOOK_SECRET = 'whsec_test_flows'

// Tier 2: "Upgrade to Pro and watch your plan flip".
//
// User-job: a Free-tier writer wants to switch to Pro to get more
// AI credits. Job done when they've clicked Upgrade on the pricing
// page, completed Stripe Checkout, returned to markoto, and seen
// the "Current plan" badge move from Free to Pro.
//
// What this flow IS: the click-through arc — pricing → Upgrade →
// (Stripe handles checkout, off-stage) → return to markoto with the
// new plan active. The tier columns themselves are covered by
// `pricing-tour` (Tier 1).
//
// Implementation note (Stripe in tests): real Stripe Checkout is a
// hosted page on a different origin we can't iframe and shouldn't
// drive end-to-end from a flow. The flow narrates the user's
// experience honestly — they click Upgrade, get redirected to
// Stripe, fill in payment, return — and the test simulates the
// post-checkout webhook directly so the "Pro is now current" payoff
// is real (the user row really updates, the pricing page really
// re-renders with the new badge). Same fixture + signature path
// the integration tests use.
//
// Works on desktop AND mobile — pricing grid stacks the same way
// across breakpoints, the post-checkout return is a full reload.
// `@billing`: needs NUXT_BILLING_ENABLED=true on the target server (see
// playwright.config.ts `grepInvert`).
test('Upgrade to Pro', { tag: '@billing' }, async ({ page, flow, editor }) => {
  test.setTimeout(180_000)

  // Login. The pricing page renders a "current plan" badge based on
  // the logged-in user's tier; for the upgrade arc to read clearly
  // we want Free as the starting state (the default for new users).
  const { userId } = await editor.page.loginAsTestUser('Maya Chen')

  // Intercept cross-origin navigations at TWO layers BEFORE the first
  // page.goto. The pricing page does `window.location.href = url` on
  // Upgrade click where `url` is the Stripe-mock checkout URL — a
  // different origin we don't want the browser to follow (separate
  // hosted page; lands on a "Something went wrong / merchant" stub
  // that poisons every subsequent screenshot/assertion).
  //
  //   1. Browser-route level (page.route). Hard-block any request to a
  //      cross-origin URL by returning an empty 200. Catches the case
  //      where the assignment triggers an actual fetch before the
  //      property setter chain runs.
  //
  //   2. JS-property level (addInitScript). Override the
  //      window.location.href setter to silently drop cross-origin
  //      writes. Must be installed BEFORE page.goto — addInitScript
  //      applies to FUTURE page loads, not the current one. (The
  //      previous shape used page.evaluate AFTER goto; that didn't
  //      survive subsequent reloads.)
  await page.addInitScript(() => {
    const proto = Object.getPrototypeOf(window.location)
    const desc = Object.getOwnPropertyDescriptor(proto, 'href')
    if (!desc?.set) return
    const sameOrigin = window.location.origin
    Object.defineProperty(window.location, 'href', {
      configurable: true,
      get: desc.get,
      set: (v: string) => {
        if (typeof v === 'string') {
          let isCrossOrigin: boolean
          try {
            const target = new URL(v, sameOrigin)
            isCrossOrigin = target.origin !== sameOrigin
          } catch {
            isCrossOrigin = false
          }
          if (isCrossOrigin) {
            console.log('[test-stub] Cross-origin redirect intercepted:', v)
            return
          }
        }
        desc.set!.call(window.location, v)
      }
    })
  })

  const appUrl = new URL(test.info().project.use.baseURL ?? 'http://localhost:3001')
  const appOrigins = new Set([
    appUrl.origin,
    `${appUrl.protocol}//localhost:${appUrl.port}`,
    `${appUrl.protocol}//127.0.0.1:${appUrl.port}`
  ])
  await page.route('**/*', async (route) => {
    const reqUrl = route.request().url()
    try {
      const target = new URL(reqUrl)
      // Allow the app's own origin (whatever host:port the flow stack
      // serves on — derived from the configured baseURL, so a remapped
      // port works too) in both its localhost / 127.0.0.1 spellings;
      // block anything else (stripe-mock at 127.0.0.1:12111, real
      // checkout.stripe.com, etc.).
      const isAllowed = appOrigins.has(target.origin)
      if (!isAllowed) {
        await route.fulfill({ status: 200, body: '', contentType: 'text/html' })
        return
      }
    } catch { /* malformed URL — let it through */ }
    await route.continue()
  })

  await page.goto('/pricing')
  await page.locator('[data-testid="pricing-tier-free"]').waitFor({ state: 'visible', timeout: 10_000 })

  // Fresh test users get the consent banner on first visit. Its
  // dialog overlay intercepts pointer events on the Upgrade button
  // below — hover/click on the button times out. Wait for the banner
  // to render (it mounts after page hydration), then dismiss it so
  // the rest of the flow can interact normally. The consent flow is
  // covered separately; we just don't want to capture it as part of
  // the upgrade story.
  const consentBanner = page.locator('[data-testid="consent-banner"]')
  await consentBanner.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {
    // Banner may not appear if a previous test in the same context
    // already accepted (shouldn't happen with fresh contexts but be
    // defensive). Skip dismiss in that case.
  })
  if (await consentBanner.isVisible().catch(() => false)) {
    await consentBanner.getByRole('button', { name: /accept all/i }).click()
    await consentBanner.waitFor({ state: 'hidden', timeout: 5_000 })
  }

  await flow.heading('Upgrade to Pro', 3)
  await flow.narrate(
    'Pro lifts the AI credits cap from 100 to 1,500 a month and '
    + 'gives you 5 owned workspaces (up from 1). The upgrade is a '
    + 'two-step click: "Upgrade" on the Pro card opens Stripe '
    + 'Checkout, you pay, Stripe redirects you back. The plan '
    + 'flips the moment Stripe sends us the webhook.'
  )

  // ─── Click Upgrade on Pro ───────────────────────────────────────
  // The CTA button doesn't carry its own testid; scope by the Pro
  // tier's container, then by the button's accessible name.
  const proCta = page.locator('[data-testid="pricing-tier-pro"]').getByRole('button', { name: /upgrade/i })
  await flow.click(
    'Click "Upgrade" on the Pro card',
    proCta,
    {
      annotations: [
        { label: 'Upgrade Pro', selector: '[data-testid="pricing-tier-pro"] button:has-text("Upgrade")', kind: 'arrow' }
      ],
      result: 'The button shows a spinner while markoto opens a Stripe Checkout session.',
      after: () => page.waitForTimeout(500)
    }
  )

  // ─── Off-stage: Stripe Checkout ─────────────────────────────────
  await flow.heading('Stripe handles the payment', 3)
  await flow.narrate(
    'You\'re redirected to Stripe\'s hosted checkout page — card '
    + 'number, expiry, CVC. (We don\'t handle your card; Stripe '
    + 'does, on their domain.) Submit, and Stripe routes you back '
    + 'to markoto with a successful-checkout marker on the URL. '
    + 'In the same beat, Stripe fires a webhook to markoto\'s '
    + 'server: "this customer just paid for Pro".'
  )

  // Simulate the webhook the way it would arrive from Stripe in
  // production. The fixture ships with stable identifiers that
  // dedup on the second project run via `processed_webhook_events`
  // AND collide on `users_stripe_customer_id_unique` if the same
  // `customer` is already bound to a previous test user. Mint
  // unique ids per invocation so each project's run lands cleanly.
  const eventSuffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const customerId = `cus_test_${eventSuffix}`
  const subscriptionId = `sub_test_${eventSuffix}`
  const event = loadStripeFixture('checkout.session.completed') as Record<string, unknown>
  event.id = `evt_test_checkout_completed_${eventSuffix}`
  const eventObj = (event.data as { object: Record<string, unknown> }).object
  eventObj.client_reference_id = String(userId)
  eventObj.customer = customerId
  eventObj.subscription = subscriptionId
  const body = JSON.stringify(event)
  const sig = computeStripeSig(body, FLOWS_WEBHOOK_SECRET)
  const webhookRes = await page.request.post('/api/webhooks/stripe', {
    headers: { 'stripe-signature': sig, 'content-type': 'application/json' },
    data: body
  })
  expect(webhookRes.status()).toBe(200)

  // To make the plan land as `pro` (not just stamp the customer id),
  // the webhook needs the price id to map to Pro. The
  // checkout.session.completed handler fetches the subscription
  // from Stripe; stripe-mock returns its own canned price id which
  // doesn't map to ours, so the plan stays Free. Drive a separate
  // subscription.updated event with our Pro price to nudge the
  // mapping. (Same pattern the stripeWebhook integration tests
  // use to exercise the price-mapping branch.)
  const subEvent = loadStripeFixture('customer.subscription.updated-pro') as Record<string, unknown>
  subEvent.id = `evt_test_sub_updated_pro_${eventSuffix}`
  const subObj = (subEvent.data as { object: Record<string, unknown> }).object
  subObj.id = subscriptionId
  subObj.customer = customerId
  // The price id in the fixture should match `NUXT_STRIPE_PRICE_PRO`.
  // The integration tests rely on the same env-var-driven mapping;
  // the fixture's price id is `price_test_pro` which is the value
  // wired into the test stack (see docker-compose.test.yml).
  //
  // Override the subscription item's period dates to "now" → "now+30d"
  // so `resolveBillingContext` doesn't demote the plan to Free via its
  // `planActive(plan, planValidUntil, now)` check. The fixture ships
  // with hard-coded epoch seconds (~April-May 2026) which expire
  // relative to wallclock — without this override the test fails the
  // moment the calendar passes the fixture's `current_period_end`.
  const items = (subObj.items as { data: Array<Record<string, unknown>> }).data
  const item = items[0]!
  const nowSec = Math.floor(Date.now() / 1000)
  item.current_period_start = nowSec
  item.current_period_end = nowSec + 30 * 24 * 60 * 60
  const subBody = JSON.stringify(subEvent)
  const subSig = computeStripeSig(subBody, FLOWS_WEBHOOK_SECRET)
  await page.request.post('/api/webhooks/stripe', {
    headers: { 'stripe-signature': subSig, 'content-type': 'application/json' },
    data: subBody
  })

  // ─── Land back on /pricing with Pro current ─────────────────────
  await flow.heading('Land back on markoto — Pro is now current', 3)
  await flow.narrate(
    'Stripe redirects you to markoto. The pricing page reloads, '
    + 'reads your new plan from your session, and the "Current '
    + 'plan" badge has moved from Free to Pro. Your AI credits jump '
    + 'from 100 to 1,500 in the same render.'
  )

  await page.goto('/pricing')
  await page.locator('[data-testid="pricing-tier-pro"]').waitFor({ state: 'visible', timeout: 10_000 })

  await flow.shot(
    'The badge moved — Pro carries the "Current plan" pill, Free '
    + 'shows the standard CTA. Behind the scenes: the webhook '
    + 'wrote `plan=pro` + `stripe_customer_id` + period anchors to '
    + 'your user row, all in one transaction.',
    {
      hero: true,
      highlights: [
        { label: 'Current plan — Pro', selector: '[data-testid="pricing-tier-pro"] [data-testid="pricing-current-plan-badge"]' }
      ]
    }
  )

  // ASSERTION: the user row updated in the DB. The pricing page UI
  // reads its current-plan badge from the same /api/_auth/session
  // response. Assert via the data-current attribute the page sets.
  await expect(page.locator('[data-testid="pricing-tier-pro"]')).toHaveAttribute('data-current', 'true', { timeout: 10_000 })
  await expect(page.locator('[data-testid="pricing-tier-free"]')).not.toHaveAttribute('data-current', 'true')

  flow.next({
    slug: 'let-your-team-use-the-ai-on-your-dime',
    why: 'Now that you\'re on Pro, you might want to upgrade to Max next — that unlocks team AI sponsoring'
  })
})
