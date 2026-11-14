import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type Stripe from 'stripe'
import { SANDBOX_CONFIGURED } from './setup/env'
import { advanceClock, deleteClock, deliverAll, retrieveSubscription, sandboxStripe } from './setup/stripe'
import { PLAN_BUDGET_USD, aiCredits, expectSameInstant, post, userBilling, userKeyBudgetUsd, userRow } from './setup/app'
import { proSubscriber, type ProPurchase } from './setup/flows'

// Scenario b: a Pro subscriber cancels to the end of the period. The app
// shows the end date while the plan still runs, and the account is back
// on Free (plan, AI budget) once Stripe's clock passes the period end.
//
// The app has no cancel button of its own: it sends the user to Stripe's
// customer portal, which no API can drive. The suite asserts that the
// portal opens for the right customer and then sets
// `cancel_at_period_end` on the subscription, which is what the portal's
// "Cancel plan" does.

describe.skipIf(!SANDBOX_CONFIGURED)('Pro: cancel at the period end', () => {
  let stripe: Stripe
  let pro: ProPurchase

  beforeAll(async () => {
    stripe = sandboxStripe()
    pro = await proSubscriber(stripe, 'cancel', { clock: true })
  })

  afterAll(async () => {
    if (pro?.clockId) await deleteClock(stripe, pro.clockId)
  })

  it('the app opens the Stripe portal for the subscriber\'s own customer', async () => {
    const portal = await post<{ url?: string }>(pro.app.client, '/api/billing/portal')
    expect(portal.status).toBe(200)
    expect(portal.body.url).toMatch(/^https:\/\/billing\.stripe\.com\//)
  })

  it('a cancelled plan stays Pro and shows when it ends', async () => {
    await stripe.subscriptions.update(pro.subscription.id, { cancel_at_period_end: true })
    const results = await deliverAll(await pro.feed.collect(['customer.subscription.updated']))
    expect(results.every(r => r.handled)).toBe(true)

    const billing = await userBilling(pro.app.client)
    expect(billing).toMatchObject({ plan: 'pro', interval: 'month' })
    expectSameInstant(billing.cancelAt, pro.subscription.current_period_end)
    expectSameInstant(billing.periodEnd, pro.subscription.current_period_end)
    // The budget stays Pro's until the end.
    expect(await aiCredits(pro.app.client)).toMatchObject({ plan: 'pro', pointsTotal: PLAN_BUDGET_USD.pro * 1000 })
    expect(await userKeyBudgetUsd(pro.app.user.id)).toBe(PLAN_BUDGET_USD.pro)
  })

  it('past the period end the account is on Free again, with the free AI budget', async () => {
    await advanceClock(stripe, pro.clockId as string, pro.subscription.current_period_end + 3600)
    expect((await retrieveSubscription(stripe, pro.subscription.id)).status).toBe('canceled')
    const results = await deliverAll(await pro.feed.collect(['customer.subscription.deleted']))
    expect(results.every(r => r.handled)).toBe(true)

    expect(await userBilling(pro.app.client)).toMatchObject({ plan: 'free', interval: null, cancelAt: null })
    expect(await aiCredits(pro.app.client)).toMatchObject({
      plan: 'free',
      pointsTotal: PLAN_BUDGET_USD.free * 1000,
      planPointsRemaining: PLAN_BUDGET_USD.free * 1000,
      creditPoints: 0
    })
    expect(await userKeyBudgetUsd(pro.app.user.id)).toBe(PLAN_BUDGET_USD.free)
    // The customer is kept for a later purchase, the subscription is gone.
    expect(await userRow(pro.app.user.id)).toMatchObject({ plan: 'free', stripe_customer_id: pro.customer.id, stripe_subscription_id: null, plan_valid_until: null })
  })
})
