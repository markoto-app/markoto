import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createError } from 'h3'
import type Stripe from 'stripe'
import { SANDBOX_CONFIGURED } from './setup/env'
import { TOPUP_VALIDITY_MONTHS } from '../../shared/config/pricing'
import { applyTestEnv } from '../integration/setup/testEnv'
import { TEST_LITELLM_DB_PASSWORD, TEST_LITELLM_DB_USER } from '../integration/setup/env'
import { LITELLM_MASTER_KEY, LITELLM_URL } from '../integration/setup/byok'
import { DAY_SECONDS, deleteCustomer, deliver, deliverAll, sandboxStripe } from './setup/stripe'
import { PLAN_BUDGET_USD, aiCredits, isoUnix, post, signedInUser, userBilling, userKeyBudgetUsd } from './setup/app'
import { buyCreditPack, proSubscriber, type ProPurchase } from './setup/flows'

// Scenarios f and g: AI credit packs on a Pro plan. A paid pack is a
// grant with a 12 month expiry that sits on top of the plan's points; a
// refund takes the refunded share back; an expired grant is gone.

const PRO_POINTS = PLAN_BUDGET_USD.pro * 1000

describe.skipIf(!SANDBOX_CONFIGURED)('AI credit packs on Pro', () => {
  let stripe: Stripe
  let pro: ProPurchase
  let refundedPayment: string

  beforeAll(async () => {
    stripe = sandboxStripe()
    pro = await proSubscriber(stripe, 'credits')
  })

  afterAll(async () => {
    if (pro) await deleteCustomer(stripe, pro.customer.id)
  })

  it('a free account cannot buy credits', async () => {
    const free = await signedInUser('credits-free')
    const refused = await post<{ data?: { code?: string } }>(free.client, '/api/billing/topup', { pack: '10', acceptPaidTerms: true })
    expect(refused.status).toBe(409)
    expect(refused.body.data?.code).toBe('billing/topup-needs-plan')
  })

  it('a paid pack is a grant that expires in 12 months, reported apart from the plan points', async () => {
    // The key exists (and carries the plan budget) before the purchase.
    expect(await aiCredits(pro.app.client)).toMatchObject({ pointsTotal: PRO_POINTS, creditPoints: 0 })

    const pack = await buyCreditPack(stripe, pro, '10')
    const boughtAt = Date.now()
    expect(await deliver(pack.completed)).toMatchObject({ handled: true })

    const billing = await userBilling(pro.app.client)
    expect(billing.plan).toBe('pro')
    expect(billing.credits).toMatchObject({ usableUsd: 10, usedThisMonthUsd: 0 })
    expect(billing.credits?.grants).toHaveLength(1)
    expect(billing.credits?.grants[0]).toMatchObject({ pack: '10', amountUsd: 10, remainingUsd: 10, refundedUsd: 0 })
    const expires = new Date(boughtAt)
    expires.setUTCMonth(expires.getUTCMonth() + TOPUP_VALIDITY_MONTHS)
    expect(Math.abs((isoUnix(billing.credits?.grants[0]?.expiresAt) as number) - Math.floor(expires.getTime() / 1000))).toBeLessThan(120)

    // Plan points and bought credits apart: the meter stays the plan's.
    expect(await aiCredits(pro.app.client)).toMatchObject({
      plan: 'pro',
      pointsTotal: PRO_POINTS,
      planPointsRemaining: PRO_POINTS,
      creditPoints: 10_000,
      pointsRemaining: PRO_POINTS + 10_000
    })
    expect(await userKeyBudgetUsd(pro.app.user.id)).toBe(PLAN_BUDGET_USD.pro + 10)

    // The same payment announced again (another event for it) grants nothing more.
    expect(await deliver({ ...pack.completed, id: `${pack.completed.id}_again` })).toMatchObject({ handled: true })
    expect((await userBilling(pro.app.client)).credits).toMatchObject({ usableUsd: 10 })
  })

  it('a partial refund takes the refunded share of the credit back', async () => {
    const pack = await buyCreditPack(stripe, pro, '25')
    refundedPayment = pack.paymentIntentId
    await deliver(pack.completed)
    expect((await userBilling(pro.app.client)).credits).toMatchObject({ usableUsd: 35 })

    // 10 of the 25 paid: a real refund, a real `charge.refunded`.
    await stripe.refunds.create({ payment_intent: refundedPayment, amount: 1000 })
    const results = await deliverAll(await pro.feed.collect(['charge.refunded']))
    expect(results.every(r => r.handled)).toBe(true)

    const credits = (await userBilling(pro.app.client)).credits
    expect(credits).toMatchObject({ usableUsd: 25 })
    expect(credits?.grants.find(g => g.pack === '25')).toMatchObject({ amountUsd: 25, refundedUsd: 10, remainingUsd: 15 })
    expect(credits?.grants.find(g => g.pack === '10')).toMatchObject({ refundedUsd: 0, remainingUsd: 10 })
    expect(await aiCredits(pro.app.client)).toMatchObject({ pointsTotal: PRO_POINTS, planPointsRemaining: PRO_POINTS, creditPoints: 25_000 })
    expect(await userKeyBudgetUsd(pro.app.user.id)).toBe(PLAN_BUDGET_USD.pro + 25)
  })

  it('refunding the rest removes that pack\'s credit, the other pack stays', async () => {
    await stripe.refunds.create({ payment_intent: refundedPayment })
    await deliverAll(await pro.feed.collect(['charge.refunded']))

    const credits = (await userBilling(pro.app.client)).credits
    expect(credits).toMatchObject({ usableUsd: 10 })
    expect(credits?.grants.find(g => g.pack === '25')).toMatchObject({ refundedUsd: 25, remainingUsd: 0 })
    expect(await aiCredits(pro.app.client)).toMatchObject({ creditPoints: 10_000, pointsRemaining: PRO_POINTS + 10_000 })
    expect(await userKeyBudgetUsd(pro.app.user.id)).toBe(PLAN_BUDGET_USD.pro + 10)
  })

  it('12 months on the credits have expired and the budget is the plan\'s again', async () => {
    // Expiry is the app's own doing, not Stripe's: the hourly
    // `ai-credit-settlement` job (`runCreditSettlement`) zeroes grants
    // past their date and lowers the LiteLLM budget. No test clock can
    // move the app's time, so the job's function is called here, in this
    // process, with "now" a day past the expiry. It works on the same
    // database and the same LiteLLM proxy as the server.
    applyTestEnv()
    Object.assign(process.env, {
      LITELLM_TEST_STUB: '',
      NUXT_BILLING_ENABLED: 'true',
      NUXT_LITELLM_URL: LITELLM_URL,
      NUXT_LITELLM_MASTER_KEY: LITELLM_MASTER_KEY,
      NUXT_LITELLM_DB_NAME: 'litellm_test',
      NUXT_LITELLM_DB_USER: TEST_LITELLM_DB_USER,
      NUXT_LITELLM_DB_PASSWORD: TEST_LITELLM_DB_PASSWORD
    })
    Object.assign(globalThis, { createError })
    const { runCreditSettlement } = await import('../../server/utils/billing/aiCredits')

    const expiry = isoUnix((await userBilling(pro.app.client)).credits?.grants.find(g => g.pack === '10')?.expiresAt) as number
    const summary = await runCreditSettlement(new Date((expiry + DAY_SECONDS) * 1000))
    expect(summary.failed).toBe(0)

    const credits = (await userBilling(pro.app.client)).credits
    expect(credits).toMatchObject({ usableUsd: 0 })
    expect(credits?.grants.find(g => g.pack === '10')).toMatchObject({ amountUsd: 10, remainingUsd: 0 })
    expect(await aiCredits(pro.app.client)).toMatchObject({ plan: 'pro', pointsTotal: PRO_POINTS, planPointsRemaining: PRO_POINTS, creditPoints: 0, pointsRemaining: PRO_POINTS })
    expect(await userKeyBudgetUsd(pro.app.user.id)).toBe(PLAN_BUDGET_USD.pro)
  })
})
