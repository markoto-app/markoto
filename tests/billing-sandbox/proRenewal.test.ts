import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type Stripe from 'stripe'
import { SANDBOX_CONFIGURED } from './setup/env'
import { advanceClock, deleteClock, deliverAll, retrieveSubscription, sandboxStripe } from './setup/stripe'
import { PLAN_BUDGET_USD, aiCredits, expectSameInstant, userBilling, userKeyBudgetUsd } from './setup/app'
import { proSubscriber, type ProPurchase } from './setup/flows'

// Scenario c: a renewal that is paid.

describe.skipIf(!SANDBOX_CONFIGURED)('Pro: a paid renewal', () => {
  let stripe: Stripe
  let pro: ProPurchase

  beforeAll(async () => {
    stripe = sandboxStripe()
    pro = await proSubscriber(stripe, 'renew', { clock: true })
  })

  afterAll(async () => {
    if (pro?.clockId) await deleteClock(stripe, pro.clockId)
  })

  it('one period later the account is still Pro, on the next period, with the full plan budget', async () => {
    await advanceClock(stripe, pro.clockId as string, pro.subscription.current_period_end + 3600)
    const renewed = await retrieveSubscription(stripe, pro.subscription.id)
    expect(renewed.status).toBe('active')
    expect(renewed.current_period_start).toBe(pro.subscription.current_period_end)

    const results = await deliverAll(await pro.feed.collect(['customer.subscription.updated', 'invoice.paid']))
    expect(results.every(r => r.handled)).toBe(true)

    const billing = await userBilling(pro.app.client)
    expect(billing).toMatchObject({ plan: 'pro', interval: 'month', cancelAt: null })
    expectSameInstant(billing.periodStart, renewed.current_period_start)
    expectSameInstant(billing.periodEnd, renewed.current_period_end)

    // The points the plan gives are whole again. The reset of what was
    // SPENT is not Stripe's doing: LiteLLM resets a key's spend on its own
    // 30-day budget window (`budget_duration`), so a renewal changes the
    // period shown and leaves the key's budget where the plan puts it.
    const credits = await aiCredits(pro.app.client)
    expect(credits).toMatchObject({
      plan: 'pro',
      pointsTotal: PLAN_BUDGET_USD.pro * 1000,
      planPointsRemaining: PLAN_BUDGET_USD.pro * 1000,
      pointsRemaining: PLAN_BUDGET_USD.pro * 1000
    })
    expectSameInstant(credits.periodEnd, renewed.current_period_end)
    expect(await userKeyBudgetUsd(pro.app.user.id)).toBe(PLAN_BUDGET_USD.pro)
  })
})
