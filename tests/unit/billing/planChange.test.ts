import { beforeEach, describe, it, expect, vi } from 'vitest'
import type Stripe from 'stripe'
import { partial } from '../../helpers/fixtures'
import { makeSubscriptionEvent } from '../../helpers/stripe'
import { splitPlanAndCreditPoints } from '../../../shared/billing/aiPoints'
import { billingIntervalOfPeriod } from '../../../shared/config/pricing'
import { subscriptionCancelAt } from '../../../server/utils/billing/stripeEvents/stripeObjects'
import { livePeriod } from '../../../server/utils/billing/stripePlanChange'
import { requestedPlan } from '../../../server/utils/billing/workspaceCheckout'
import { handleSubscriptionUpdated } from '../../../server/utils/billing/stripeEvents/subscriptionEvents'

// What a plan / billing-period change means and how its state is read:
// the request that names only one of the two, the subscription that ends
// instead of renewing, and AI points split into plan budget and credits.

const DAY_S = 24 * 3600

function subscription(fields: { priceLookupKey?: string, priceId?: string, cancelAt?: number | null, cancelAtPeriodEnd?: boolean, periodStart?: number, periodEnd?: number }): Stripe.Subscription {
  return partial<Stripe.Subscription>({
    id: 'sub_live',
    cancel_at: fields.cancelAt ?? null,
    cancel_at_period_end: fields.cancelAtPeriodEnd ?? false,
    items: partial<Stripe.Subscription['items']>({
      data: [partial<Stripe.SubscriptionItem>({
        id: 'si_1',
        price: partial<Stripe.Price>({ id: fields.priceId ?? 'price_x', lookup_key: fields.priceLookupKey ?? null }),
        current_period_start: fields.periodStart ?? 1_800_000_000,
        current_period_end: fields.periodEnd ?? 1_800_000_000 + 30 * DAY_S
      })]
    })
  })
}

const NO_STRIPE = partial<Stripe>({})

describe('requestedPlan: a change names only what changes', () => {
  beforeEach(() => {
    vi.stubEnv('NUXT_STRIPE_PRICE_IDS', '')
  })

  const businessYearly = subscription({ priceLookupKey: 'markoto_business_year_eur' })

  it('a plan-only request keeps the live subscription\'s billing period', async () => {
    // The row still says monthly (a page that has not caught up): Stripe's price decides.
    expect(await requestedPlan(NO_STRIPE, { plan: 'team', interval: undefined }, businessYearly, { plan: 'business', interval: 'month' }))
      .toEqual({ plan: 'team', interval: 'year' })
  })

  it('an interval-only request keeps the live subscription\'s plan', async () => {
    expect(await requestedPlan(NO_STRIPE, { plan: undefined, interval: 'month' }, businessYearly, { plan: 'team', interval: 'year' }))
      .toEqual({ plan: 'business', interval: 'month' })
  })

  it('falls back to the stored row when the live price is not one of ours', async () => {
    const unknown = subscription({ priceId: 'price_unknown' })
    expect(await requestedPlan(NO_STRIPE, { plan: 'team', interval: undefined }, unknown, { plan: 'business', interval: 'year' }))
      .toEqual({ plan: 'team', interval: 'year' })
    expect(await requestedPlan(NO_STRIPE, { plan: undefined, interval: 'month' }, unknown, { plan: 'business', interval: 'year' }))
      .toEqual({ plan: 'business', interval: 'month' })
  })

  it('a request that names both is taken as is', async () => {
    expect(await requestedPlan(NO_STRIPE, { plan: 'team', interval: 'month' }, businessYearly, { plan: 'business', interval: 'year' }))
      .toEqual({ plan: 'team', interval: 'month' })
  })

  it('a new subscription is monthly by default and needs a plan', async () => {
    expect(await requestedPlan(NO_STRIPE, { plan: 'team', interval: undefined }, null, null)).toEqual({ plan: 'team', interval: 'month' })
    expect(await requestedPlan(NO_STRIPE, { plan: 'business', interval: 'year' }, null, null)).toEqual({ plan: 'business', interval: 'year' })
    await expect(requestedPlan(NO_STRIPE, { plan: undefined, interval: 'year' }, null, null)).rejects.toMatchObject({ statusCode: 400 })
  })
})

describe('subscriptionCancelAt', () => {
  it('is null while the subscription renews', () => {
    expect(subscriptionCancelAt(subscription({}))).toBeNull()
  })
  it('is the period end for a portal cancellation (cancel_at_period_end)', () => {
    const end = 1_800_000_000 + 30 * DAY_S
    expect(subscriptionCancelAt(subscription({ cancelAtPeriodEnd: true, periodEnd: end }))).toEqual(new Date(end * 1000))
  })
  it('is cancel_at when Stripe names the date itself', () => {
    expect(subscriptionCancelAt(subscription({ cancelAt: 1_900_000_000 }))).toEqual(new Date(1_900_000_000 * 1000))
  })
})

describe('livePeriod', () => {
  const now = new Date(1_800_000_000 * 1000 + 1000)
  it('returns the period of a live subscription', () => {
    expect(livePeriod(subscription({}), now)).toEqual({ start: new Date(1_800_000_000 * 1000), end: new Date((1_800_000_000 + 30 * DAY_S) * 1000) })
  })
  it('ignores a period that already ended (not a live subscription\'s)', () => {
    expect(livePeriod(subscription({ periodStart: 1_000_000_000, periodEnd: 1_000_000_000 + 30 * DAY_S }), now)).toBeNull()
  })
})

describe('billingIntervalOfPeriod', () => {
  const start = new Date('2027-01-31T00:00:00Z')
  it('reads a period of up to a month as monthly, a year as annual', () => {
    expect(billingIntervalOfPeriod(start, new Date('2027-02-28T00:00:00Z'))).toBe('month')
    expect(billingIntervalOfPeriod(start, new Date('2027-03-03T00:00:00Z'))).toBe('month')
    expect(billingIntervalOfPeriod(start, new Date('2028-01-31T00:00:00Z'))).toBe('year')
  })
})

describe('splitPlanAndCreditPoints', () => {
  it('a credit pack sits on top of the plan: plan points never exceed the total', () => {
    // Pro ($5) + a $10 pack, 1.2 cents spent.
    expect(splitPlanAndCreditPoints({ maxBudgetUsd: 15, spendUsd: 0.012, planBudgetUsd: 5 })).toEqual({
      pointsRemaining: 14988,
      pointsTotal: 5000,
      planPointsRemaining: 4988,
      creditPoints: 10000
    })
  })
  it('the plan budget is spent first, then the credits', () => {
    expect(splitPlanAndCreditPoints({ maxBudgetUsd: 15, spendUsd: 7, planBudgetUsd: 5 })).toEqual({
      pointsRemaining: 8000,
      pointsTotal: 5000,
      planPointsRemaining: 0,
      creditPoints: 8000
    })
  })
  it('without credits everything left is plan budget', () => {
    expect(splitPlanAndCreditPoints({ maxBudgetUsd: 5, spendUsd: 2, planBudgetUsd: 5 })).toMatchObject({ pointsRemaining: 3000, planPointsRemaining: 3000, creditPoints: 0 })
  })
  it('a key budget below the plan (not synced yet) never shows more than the key has', () => {
    expect(splitPlanAndCreditPoints({ maxBudgetUsd: 0.5, spendUsd: 0.1, planBudgetUsd: 5 })).toMatchObject({ pointsRemaining: 400, planPointsRemaining: 400, creditPoints: 0 })
  })
  it('an overspent key has nothing left', () => {
    expect(splitPlanAndCreditPoints({ maxBudgetUsd: 5, spendUsd: 6, planBudgetUsd: 5 })).toMatchObject({ pointsRemaining: 0, planPointsRemaining: 0, creditPoints: 0 })
  })
})

describe('customer.subscription.updated: billing period and cancellation on the user row', () => {
  /** A transaction handle that maps the customer to user 42 and records what is written. */
  function recordingDb() {
    const sets: Array<Record<string, unknown>> = []
    const db = {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ id: 42 }] }) }) }),
      update: () => ({
        set: (fields: Record<string, unknown>) => {
          sets.push(fields)
          return { where: () => ({ returning: async () => [{ id: 42 }] }) }
        }
      })
    }
    return { db: db as unknown as NonNullable<Parameters<typeof handleSubscriptionUpdated>[1]>['db'], sets }
  }

  beforeEach(() => {
    vi.stubEnv('NUXT_STRIPE_PRICE_IDS', 'markoto_pro_year_eur=price_pro_year')
  })

  it('a cancellation in the portal stores when the plan ends', async () => {
    const { db, sets } = recordingDb()
    const event = makeSubscriptionEvent({ type: 'customer.subscription.updated', customer: 'cus', priceId: 'price_pro_year', cancelAtPeriodEnd: true, periodEnd: 1_900_000_000 })
    const result = await handleSubscriptionUpdated(event, { db })
    expect(result).toEqual({ matched: 1, plan: 'pro' })
    expect(sets[0]).toMatchObject({ plan: 'pro', billingInterval: 'year', planCancelAt: new Date(1_900_000_000 * 1000) })
  })

  it('a renewing subscription clears it again', async () => {
    const { db, sets } = recordingDb()
    const event = makeSubscriptionEvent({ type: 'customer.subscription.updated', customer: 'cus', priceId: 'price_pro_year' })
    await handleSubscriptionUpdated(event, { db })
    expect(sets[0]).toMatchObject({ billingInterval: 'year', planCancelAt: null })
  })
})
