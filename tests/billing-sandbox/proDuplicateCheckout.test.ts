import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type Stripe from 'stripe'
import { SANDBOX_CONFIGURED } from './setup/env'
import { completedCheckoutEvent, deleteCustomer, deliver, deliverAll, priceByLookupKey, retrieveSubscription, runTag, sandboxStripe } from './setup/stripe'
import { PLAN_BUDGET_USD, userKeyBudgetUsd, userRow } from './setup/app'
import { proSubscriber, type ProPurchase } from './setup/flows'

// Two personal checkouts on one customer: a second tab (or a stale
// Checkout page) is paid after the first purchase went through. The app
// keeps the first subscription, cancels the second at once and refunds
// its payment; the user stays on Pro with one subscription billing.

describe.skipIf(!SANDBOX_CONFIGURED)('Pro: a second completed checkout is cancelled and refunded', () => {
  let stripe: Stripe
  let pro: ProPurchase
  let second: Stripe.Subscription | null = null

  beforeAll(async () => {
    stripe = sandboxStripe()
    pro = await proSubscriber(stripe, 'second-checkout')
  })

  afterAll(async () => {
    // Every subscription this scenario created ends, then its customer goes.
    for (const id of [second?.id, pro?.subscription.id]) {
      if (!id) continue
      const sub = await stripe.subscriptions.retrieve(id)
      if (sub.status !== 'canceled' && sub.status !== 'incomplete_expired') await stripe.subscriptions.cancel(id)
    }
    if (pro?.customer) await deleteCustomer(stripe, pro.customer.id)
  })

  async function paymentIntentOf(sub: Stripe.Subscription): Promise<string> {
    const invoiceId = typeof sub.latest_invoice === 'string' ? sub.latest_invoice : sub.latest_invoice?.id
    expect(invoiceId).toBeTruthy()
    for await (const payment of stripe.invoicePayments.list({ invoice: invoiceId as string, status: 'paid' })) {
      const pi = payment.payment.payment_intent
      const id = typeof pi === 'string' ? pi : pi?.id
      if (id) return id
    }
    throw new Error(`no paid payment on ${invoiceId}`)
  }

  it('the second subscription is cancelled, its payment refunded, the first stays tracked', async () => {
    // What the second tab's Checkout page does on payment: another
    // subscription on the same customer.
    second = await stripe.subscriptions.create({
      customer: pro.customer.id,
      items: [{ price: await priceByLookupKey(stripe, 'markoto_pro_month_eur'), quantity: 1 }],
      metadata: { subject_type: 'user', subject_id: String(pro.app.user.id), ...runTag() }
    })
    expect(second.status).toBe('active')
    const real = await pro.feed.collect(['customer.subscription.created', 'invoice.paid'])
    const staleSession = { ...pro.session, id: `${pro.session.id}_second_tab` }
    const checkout = completedCheckoutEvent(staleSession, { customer: pro.customer.id, subscription: second.id })
    const results = await deliverAll([...real, checkout])
    expect(results.every(r => r.received)).toBe(true)

    expect((await retrieveSubscription(stripe, second.id)).status).toBe('canceled')
    expect((await retrieveSubscription(stripe, pro.subscription.id)).status).toBe('active')
    const refunds = await stripe.refunds.list({ payment_intent: await paymentIntentOf(second) })
    expect(refunds.data).toHaveLength(1)
    expect(refunds.data[0]).toMatchObject({ metadata: { reason: 'duplicate_personal_subscription', subscription_id: second.id } })
    expect(await userRow(pro.app.user.id)).toMatchObject({ plan: 'pro', stripe_customer_id: pro.customer.id, stripe_subscription_id: pro.subscription.id })

    // A redelivery of the checkout refunds nothing twice.
    expect((await deliver({ ...checkout, id: `${checkout.id}_retry` })).received).toBe(true)
    expect((await stripe.refunds.list({ payment_intent: await paymentIntentOf(second) })).data).toHaveLength(1)
  })

  it('the cancellation and refund events keep the user on Pro with Pro\'s AI budget', async () => {
    const results = await deliverAll(await pro.feed.collect(['customer.subscription.deleted', 'charge.refunded']))
    expect(results.every(r => r.received)).toBe(true)

    expect(await userRow(pro.app.user.id)).toMatchObject({ plan: 'pro', stripe_subscription_id: pro.subscription.id })
    expect(await userKeyBudgetUsd(pro.app.user.id)).toBe(PLAN_BUDGET_USD.pro)
    const live = await stripe.subscriptions.list({ customer: pro.customer.id, status: 'active' })
    expect(live.data.map(s => s.id)).toEqual([pro.subscription.id])
  })
})
