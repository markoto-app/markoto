import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type Stripe from 'stripe'
import { SANDBOX_CONFIGURED } from './setup/env'
import { expireCheckout, sandboxStripe } from './setup/stripe'
import { post, signedInUser, type AppUser } from './setup/app'

// A first-time buyer opens Pro Checkout in two tabs. Opening the second
// expires the first, so only the newest Checkout can still be paid and
// the buyer can never end up with two subscriptions from it.

describe.skipIf(!SANDBOX_CONFIGURED)('Pro: a new checkout expires the buyer\'s older open one', () => {
  let stripe: Stripe
  let app: AppUser
  const opened: string[] = []

  beforeAll(async () => {
    stripe = sandboxStripe()
    app = await signedInUser('stale-checkout')
  })

  afterAll(async () => {
    for (const id of opened) await expireCheckout(stripe, id)
  })

  async function openCheckout(): Promise<string> {
    const res = await post<{ sessionId?: string }>(app.client, '/api/billing/checkout', { plan: 'pro', interval: 'month', currency: 'eur', acceptPaidTerms: true })
    expect(res.status).toBe(200)
    const id = res.body.sessionId as string
    opened.push(id)
    return id
  }

  it('the first tab\'s session is expired, the second stays open', async () => {
    const first = await openCheckout()
    expect((await stripe.checkout.sessions.retrieve(first)).status).toBe('open')
    const second = await openCheckout()
    expect((await stripe.checkout.sessions.retrieve(first)).status).toBe('expired')
    expect((await stripe.checkout.sessions.retrieve(second)).status).toBe('open')
  })
})
