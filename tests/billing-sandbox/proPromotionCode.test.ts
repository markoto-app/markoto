import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type Stripe from 'stripe'
import { SANDBOX_CONFIGURED } from './setup/env'
import { deleteCustomer, priceByLookupKey, runTag, sandboxStripe } from './setup/stripe'
import { PLAN_BUDGET_USD, aiCredits, expectSameInstant, userBilling, userKeyBudgetUsd } from './setup/app'
import { buyPro, deliverPurchase, type ProPurchase } from './setup/flows'

// Scenario: a launch promotion. A shared promotion code takes 40% off the
// first year of Pro yearly. The app's yearly checkout (Managed Payments on,
// as in production) offers the code field; the buyer's code discounts the
// first invoice; the discounted purchase makes the account Pro yearly with
// the full plan budget, exactly like an undiscounted one.

describe.skipIf(!SANDBOX_CONFIGURED)('Pro yearly with a launch promotion code', () => {
  let stripe: Stripe
  let coupon: Stripe.Coupon
  let promotionCode: Stripe.PromotionCode
  let pro: ProPurchase
  let yearlyPrice: Stripe.Price

  beforeAll(async () => {
    stripe = sandboxStripe()
    yearlyPrice = await stripe.prices.retrieve(await priceByLookupKey(stripe, 'markoto_pro_year_eur'))
    const product = typeof yearlyPrice.product === 'string' ? yearlyPrice.product : yearlyPrice.product.id
    coupon = await stripe.coupons.create({
      percent_off: 40,
      duration: 'once',
      applies_to: { products: [product] },
      name: 'markoto sandbox launch',
      metadata: runTag()
    })
    promotionCode = await stripe.promotionCodes.create({
      promotion: { type: 'coupon', coupon: coupon.id },
      expires_at: Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
      metadata: runTag()
    })
    pro = await buyPro(stripe, 'promo', { interval: 'year', promotionCode: promotionCode.id })
  })

  afterAll(async () => {
    if (pro) await deleteCustomer(stripe, pro.customer.id)
    // A promotion code can't be deleted; without its coupon it can't be redeemed.
    if (promotionCode) await stripe.promotionCodes.update(promotionCode.id, { active: false, metadata: runTag() })
    if (coupon) await stripe.coupons.del(coupon.id)
  })

  it('the yearly Checkout Session (Managed Payments) accepts promotion codes', () => {
    // `buyPro` asserts the same for every scenario; named here as the point of this one.
    expect(pro.session.allow_promotion_codes).toBe(true)
  })

  it('the first invoice is the yearly price less 40%', async () => {
    const invoiceId = typeof pro.subscription.latest_invoice === 'string' ? pro.subscription.latest_invoice : pro.subscription.latest_invoice?.id
    const invoice = await stripe.invoices.retrieve(invoiceId as string)
    const full = yearlyPrice.unit_amount as number
    expect(invoice.status).toBe('paid')
    expect(invoice.subtotal).toBe(full)
    expect(invoice.amount_paid).toBe(Math.round(full * 0.6))
  })

  it('the discounted purchase makes the account Pro yearly with the full plan budget', async () => {
    await deliverPurchase(pro)

    const billing = await userBilling(pro.app.client)
    expect(billing).toMatchObject({ plan: 'pro', interval: 'year', cancelAt: null })
    expectSameInstant(billing.periodEnd, pro.subscription.current_period_end)

    const credits = await aiCredits(pro.app.client)
    expect(credits).toMatchObject({ plan: 'pro', pointsTotal: PLAN_BUDGET_USD.pro * 1000 })
    expect(await userKeyBudgetUsd(pro.app.user.id)).toBe(PLAN_BUDGET_USD.pro)
  })
})
