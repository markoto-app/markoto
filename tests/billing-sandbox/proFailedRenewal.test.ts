import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type Stripe from 'stripe'
import { SANDBOX_CONFIGURED } from './setup/env'
import { CARD_DECLINES, DAY_SECONDS, advanceClock, deleteClock, deliverAll, retrieveSubscription, sandboxStripe, setDefaultCard } from './setup/stripe'
import { PLAN_BUDGET_USD, aiCredits, expectSameInstant, userBilling, userKeyBudgetUsd, userRow } from './setup/app'
import { proSubscriber, type ProPurchase } from './setup/flows'

// Scenario d: a renewal whose payment fails, through Stripe's retries to
// the end of the subscription.

describe.skipIf(!SANDBOX_CONFIGURED)('Pro: a renewal whose payment fails', () => {
  let stripe: Stripe
  let pro: ProPurchase

  beforeAll(async () => {
    stripe = sandboxStripe()
    pro = await proSubscriber(stripe, 'dunning', { clock: true })
  })

  afterAll(async () => {
    if (pro?.clockId) await deleteClock(stripe, pro.clockId)
  })

  // The contract as observed against the sandbox (its retry settings: three
  // more attempts over about three weeks, then the subscription is
  // cancelled). The app never downgrades on a failed payment by itself.

  it('while Stripe retries, the account stays Pro and shows the next period as if it had renewed', async () => {
    await setDefaultCard(stripe, pro.customer.id, CARD_DECLINES)
    await advanceClock(stripe, pro.clockId as string, pro.subscription.current_period_end + 3600)
    const unpaid = await retrieveSubscription(stripe, pro.subscription.id)
    // Stripe starts the next period whether or not it was paid.
    expect(unpaid.status).toBe('past_due')
    expect(unpaid.current_period_start).toBe(pro.subscription.current_period_end)

    const results = await deliverAll(await pro.feed.collect(['customer.subscription.updated', 'invoice.payment_failed']))
    expect(results.every(r => r.handled)).toBe(true)

    // Nothing in `/api/user/billing` says a payment is overdue: the plan,
    // the period and the budget are those of a paid renewal.
    const billing = await userBilling(pro.app.client)
    expect(billing).toMatchObject({ plan: 'pro', interval: 'month', cancelAt: null })
    expectSameInstant(billing.periodEnd, unpaid.current_period_end)
    expect(await aiCredits(pro.app.client)).toMatchObject({ plan: 'pro', pointsTotal: PLAN_BUDGET_USD.pro * 1000 })
    expect(await userKeyBudgetUsd(pro.app.user.id)).toBe(PLAN_BUDGET_USD.pro)
  })

  it('when Stripe gives up and ends the subscription, the account is on Free with the free AI budget', async () => {
    let now = pro.subscription.current_period_end + 3600
    let status = 'past_due'
    // Stripe's retry schedule, a week at a time, each step's events delivered as they come.
    for (let week = 0; week < 5 && status !== 'canceled'; week++) {
      now += 7 * DAY_SECONDS
      await advanceClock(stripe, pro.clockId as string, now)
      status = (await retrieveSubscription(stripe, pro.subscription.id)).status
      await deliverAll(await pro.feed.collect(status === 'canceled' ? ['customer.subscription.deleted'] : []))
      if (status !== 'canceled') expect((await userBilling(pro.app.client)).plan).toBe('pro')
    }
    expect(status).toBe('canceled')

    expect(await userBilling(pro.app.client)).toMatchObject({ plan: 'free', interval: null, cancelAt: null })
    expect(await aiCredits(pro.app.client)).toMatchObject({ plan: 'free', pointsTotal: PLAN_BUDGET_USD.free * 1000 })
    expect(await userKeyBudgetUsd(pro.app.user.id)).toBe(PLAN_BUDGET_USD.free)
    expect(await userRow(pro.app.user.id)).toMatchObject({ plan: 'free', stripe_subscription_id: null })
  })
})
