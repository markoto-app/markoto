import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type Stripe from 'stripe'
import { SANDBOX_CONFIGURED } from './setup/env'
import { DAY_SECONDS, deleteCustomer, deliverAll, retrieveSubscription, sandboxStripe } from './setup/stripe'
import { PLAN_BUDGET_USD, aiCredits, expectSameInstant, isoUnix, post, userBilling, userKeyBudgetUsd, userRow } from './setup/app'
import { buyPro, deliverPurchase, type ProPurchase } from './setup/flows'

// Scenario a: a free account buys Pro monthly, then switches the live
// subscription to annual billing in place. The switch has to show at once
// (the app writes it itself) and stay right once Stripe's events arrive.

describe.skipIf(!SANDBOX_CONFIGURED)('Pro: free to monthly, then monthly to annual in place', () => {
  let stripe: Stripe
  let pro: ProPurchase

  beforeAll(async () => {
    stripe = sandboxStripe()
    pro = await buyPro(stripe, 'switch')
  })

  afterAll(async () => {
    if (pro) await deleteCustomer(stripe, pro.customer.id)
  })

  it('before the purchase reaches the app the account is on Free with the free AI budget', async () => {
    expect(await userBilling(pro.app.client)).toMatchObject({ plan: 'free', interval: null, cancelAt: null })
    const credits = await aiCredits(pro.app.client)
    expect(credits).toMatchObject({ plan: 'free', attribution: 'user', pointsTotal: PLAN_BUDGET_USD.free * 1000, creditPoints: 0 })
    expect(await userKeyBudgetUsd(pro.app.user.id)).toBe(PLAN_BUDGET_USD.free)
  })

  it('the purchase makes the account Pro, monthly, renewing at Stripe\'s period end', async () => {
    await deliverPurchase(pro)

    const billing = await userBilling(pro.app.client)
    expect(billing).toMatchObject({ plan: 'pro', interval: 'month', cancelAt: null })
    expectSameInstant(billing.periodStart, pro.subscription.current_period_start)
    expectSameInstant(billing.periodEnd, pro.subscription.current_period_end)

    const credits = await aiCredits(pro.app.client)
    expect(credits).toMatchObject({
      plan: 'pro',
      pointsTotal: PLAN_BUDGET_USD.pro * 1000,
      planPointsRemaining: PLAN_BUDGET_USD.pro * 1000,
      creditPoints: 0
    })
    expectSameInstant(credits.periodEnd, pro.subscription.current_period_end)
    expect(await userKeyBudgetUsd(pro.app.user.id)).toBe(PLAN_BUDGET_USD.pro)
    expect(await userRow(pro.app.user.id)).toMatchObject({
      stripe_customer_id: pro.customer.id,
      stripe_subscription_id: pro.subscription.id,
      billing_currency: 'eur'
    })
  })

  it('the same price again is refused, nothing is bought twice', async () => {
    const again = await post<{ data?: { code?: string } }>(pro.app.client, '/api/billing/checkout', { plan: 'pro', interval: 'month', acceptPaidTerms: true })
    expect(again.status).toBe(409)
    expect(again.body.data?.code).toBe('billing/already-on-plan')
  })

  it('monthly to annual shows at once, before any webhook is delivered', async () => {
    const change = await post(pro.app.client, '/api/billing/checkout', { plan: 'pro', interval: 'year', acceptPaidTerms: true })
    expect(change).toEqual({ status: 200, body: { updated: true, plan: 'pro', interval: 'year' } })

    // Stripe: the same subscription, now on the annual price, period restarted.
    const live = await retrieveSubscription(stripe, pro.subscription.id)
    expect(live.status).toBe('active')
    expect(live.items.data[0]?.price.lookup_key).toBe('markoto_pro_year_eur')
    expect(live.current_period_end - live.current_period_start).toBeGreaterThanOrEqual(365 * DAY_SECONDS)

    const billing = await userBilling(pro.app.client)
    expect(billing).toMatchObject({ plan: 'pro', interval: 'year', cancelAt: null })
    expectSameInstant(billing.periodEnd, live.current_period_end)
    expectSameInstant((await aiCredits(pro.app.client)).periodEnd, live.current_period_end)
  })

  it('and is still right after Stripe\'s events for the switch', async () => {
    const before = await userBilling(pro.app.client)
    const events = await pro.feed.collect(['customer.subscription.updated', 'invoice.paid'])
    const results = await deliverAll(events)
    expect(results.every(r => r.handled && !r.stashed)).toBe(true)
    // The switch's own event was applied, not taken for an older one: the
    // row now carries its time (the app's write carried Stripe's time just
    // before the change).
    const updated = events.filter(e => e.type === 'customer.subscription.updated').at(-1)
    expect((await userRow(pro.app.user.id)).subscription_event_at?.getTime()).toBe((updated?.created ?? 0) * 1000)

    const live = await retrieveSubscription(stripe, pro.subscription.id)
    const billing = await userBilling(pro.app.client)
    expect(billing).toMatchObject({ plan: 'pro', interval: 'year', cancelAt: null })
    expect(isoUnix(billing.periodEnd)).toBe(isoUnix(before.periodEnd))
    expectSameInstant(billing.periodStart, live.current_period_start)
    expectSameInstant(billing.periodEnd, live.current_period_end)
    expect(await aiCredits(pro.app.client)).toMatchObject({ plan: 'pro', pointsTotal: PLAN_BUDGET_USD.pro * 1000 })
    expect(await userKeyBudgetUsd(pro.app.user.id)).toBe(PLAN_BUDGET_USD.pro)
    // One subscription, never a second one.
    const subscriptions = await stripe.subscriptions.list({ customer: pro.customer.id, status: 'all' })
    expect(subscriptions.data.map(s => s.id)).toEqual([pro.subscription.id])
  })
})
