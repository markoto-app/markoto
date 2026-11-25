import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type Stripe from 'stripe'
import { SANDBOX_CONFIGURED } from './setup/env'
import { deleteCustomer, deliverAll, priceByLookupKey, retrieveSubscription, runTag, sandboxStripe } from './setup/stripe'
import { PLAN_BUDGET_USD, aiCredits, expectSameInstant, userBilling, userKeyBudgetUsd, userRow } from './setup/app'
import { proSubscriber, type ProPurchase } from './setup/flows'

// A Pro subscriber whose customer holds a SECOND Pro subscription (a
// double checkout, an old one that support later cleans up). The app
// tracks the first; cancelling the second must leave the user on Pro with
// Pro's AI budget, because the tracked subscription is still live and
// billed.

describe.skipIf(!SANDBOX_CONFIGURED)('Pro: a cancelled duplicate subscription keeps the plan', () => {
  let stripe: Stripe
  let pro: ProPurchase
  let duplicate: Stripe.Subscription | null = null

  beforeAll(async () => {
    stripe = sandboxStripe()
    pro = await proSubscriber(stripe, 'duplicate')
  })

  afterAll(async () => {
    // Every subscription this scenario created ends, then its customer goes.
    for (const id of [duplicate?.id, pro?.subscription.id]) {
      if (!id) continue
      const sub = await stripe.subscriptions.retrieve(id)
      if (sub.status !== 'canceled' && sub.status !== 'incomplete_expired') await stripe.subscriptions.cancel(id)
    }
    if (pro?.customer) await deleteCustomer(stripe, pro.customer.id)
  })

  it('a second subscription of the same customer does not replace the tracked one', async () => {
    duplicate = await stripe.subscriptions.create({
      customer: pro.customer.id,
      items: [{ price: await priceByLookupKey(stripe, 'markoto_pro_month_eur'), quantity: 1 }],
      metadata: { subject_type: 'user', subject_id: String(pro.app.user.id), ...runTag() }
    })
    expect(duplicate.status).toBe('active')
    const results = await deliverAll(await pro.feed.collect(['customer.subscription.created', 'invoice.paid']))
    expect(results.every(r => r.received)).toBe(true)

    expect(await userRow(pro.app.user.id)).toMatchObject({ plan: 'pro', stripe_subscription_id: pro.subscription.id })
  })

  it('cancelling the duplicate keeps the user on Pro, with Pro\'s AI budget', async () => {
    await stripe.subscriptions.cancel((duplicate as Stripe.Subscription).id)
    const results = await deliverAll(await pro.feed.collect(['customer.subscription.deleted']))
    expect(results.every(r => r.received)).toBe(true)

    expect((await retrieveSubscription(stripe, pro.subscription.id)).status).toBe('active')
    expect(await userRow(pro.app.user.id)).toMatchObject({ plan: 'pro', stripe_customer_id: pro.customer.id, stripe_subscription_id: pro.subscription.id })
    const billing = await userBilling(pro.app.client)
    expect(billing).toMatchObject({ plan: 'pro', interval: 'month', cancelAt: null })
    expectSameInstant(billing.periodEnd, pro.subscription.current_period_end)
    expect(await aiCredits(pro.app.client)).toMatchObject({ plan: 'pro', pointsTotal: PLAN_BUDGET_USD.pro * 1000 })
    expect(await userKeyBudgetUsd(pro.app.user.id)).toBe(PLAN_BUDGET_USD.pro)
  })

  it('cancelling the tracked subscription then ends the plan', async () => {
    await stripe.subscriptions.cancel(pro.subscription.id)
    const results = await deliverAll(await pro.feed.collect(['customer.subscription.deleted']))
    expect(results.every(r => r.handled)).toBe(true)

    expect(await userRow(pro.app.user.id)).toMatchObject({ plan: 'free', stripe_subscription_id: null })
    expect(await userKeyBudgetUsd(pro.app.user.id)).toBe(PLAN_BUDGET_USD.free)
  })
})
