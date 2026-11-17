import { describe, it, expect } from 'vitest'
import {
  combinedRevenueChf, defaultBucket, estimateContribution, isoDay, pct, percentChange, recurringRevenue, round2, statsWindow, type SubscriptionGroup
} from '../../../shared/contracts/adminStats'
import { subscriptionEventKinds } from '../../../server/utils/billing/stripeEvents/subscriptionHistory'
import { rollupWindow } from '../../../server/utils/litellm/aiSpendRollup'
import { DEFAULT_PLAN_PRICES } from '../../../shared/config/pricing'
import { adminStatsQuery } from '../../../shared/api/legal'
import { buildCohortTable, mondayWeeksBack, spendLogFloor, COHORT_WEEKS } from '../../../server/utils/adminStats/productStats'
import { cachedAdminStats, clearAdminStatsCache, STATS_CACHE_TTL_MS } from '../../../server/utils/adminStats/statsCache'

// Admin product stats: windows, period change, MRR at list price, the
// cohort table, the response cache and the query schema.

const NOW = new Date('2026-11-17T15:00:00Z')

describe('statsWindow', () => {
  it('ends tomorrow so today counts, and starts N days back', () => {
    expect(statsWindow('7', NOW, null)).toEqual({ range: '7', from: '2026-11-11', to: '2026-11-18', prevFrom: '2026-11-04', bucket: 'day' })
    expect(statsWindow('365', NOW, null).bucket).toBe('week')
    expect(statsWindow('30', NOW, null, 'month').bucket).toBe('month')
  })

  it('starts "all" at the first sign-up, at most 60 months back, without a previous window', () => {
    expect(statsWindow('all', NOW, '2026-03-02')).toEqual({ range: 'all', from: '2026-03-02', to: '2026-11-18', prevFrom: null, bucket: 'month' })
    expect(statsWindow('all', NOW, '2001-01-01').from).toBe('2021-12-01')
    expect(statsWindow('all', NOW, null).from).toBe('2021-12-01')
  })

  it('picks a bucket per range', () => {
    expect(defaultBucket('90')).toBe('day')
    expect(defaultBucket('all')).toBe('month')
    expect(isoDay(NOW)).toBe('2026-11-17')
  })
})

describe('percentChange', () => {
  it('is relative to the previous window', () => {
    expect(percentChange({ value: 15, previous: 10 })).toBe(50)
    expect(percentChange({ value: 5, previous: 10 })).toBe(-50)
  })

  it('has no comparison without a previous value or from zero', () => {
    expect(percentChange({ value: 3, previous: null })).toBeNull()
    expect(percentChange({ value: 3, previous: 0 })).toBeNull()
    expect(percentChange({ value: 0, previous: 0 })).toBe(0)
  })
})

describe('recurringRevenue', () => {
  const g = (o: Partial<SubscriptionGroup>): SubscriptionGroup => ({ plan: 'pro', currency: 'eur', interval: 'month', subscriptions: 1, units: 1, ...o })

  it('normalises yearly plans to a month and multiplies seats', () => {
    expect(recurringRevenue([
      g({}),
      g({ interval: 'year', subscriptions: 2, units: 2 }),
      g({ plan: 'team', currency: 'chf', units: 4 }),
      g({ plan: 'business', currency: 'chf', interval: 'year', units: 3 })
    ], DEFAULT_PLAN_PRICES)).toEqual([
      { currency: 'chf', mrr: 98, arr: 1176 },
      { currency: 'eur', mrr: 24, arr: 288 }
    ])
  })

  it('is empty without subscriptions', () => {
    expect(recurringRevenue([], DEFAULT_PLAN_PRICES)).toEqual([])
  })

  it('rounds and computes shares safely', () => {
    expect(round2(1 / 3)).toBeCloseTo(0.33, 5)
    expect(pct(1, 3)).toBeCloseTo(33.3, 5)
    expect(pct(1, 0)).toBe(0)
  })
})

describe('cohort table', () => {
  it('fills elapsed weeks with shares and future weeks with null', () => {
    const table = buildCohortTable(
      [{ week: '2026-11-02', size: 4 }, { week: '2026-11-16', size: 2 }],
      [{ week: '2026-11-02', offset: 0, users: 4 }, { week: '2026-11-02', offset: 2, users: 1 }],
      '2026-11-16'
    )
    expect(table[0]?.retention.slice(0, 4)).toEqual([100, 0, 25, null])
    expect(table[1]?.retention.slice(0, 2)).toEqual([0, null])
    expect(table[0]?.retention).toHaveLength(COHORT_WEEKS)
  })

  it('finds the Monday of past weeks in UTC', () => {
    expect(mondayWeeksBack(NOW, 0)).toBe('2026-11-16')
    expect(mondayWeeksBack(new Date('2026-11-22T23:00:00Z'), 1)).toBe('2026-11-09')
  })

  it('knows where the spend logs end', () => {
    expect(spendLogFloor(statsWindow('365', NOW, null))).toBe('2026-08-21')
  })
})

describe('admin stats cache', () => {
  it('reuses a result for a minute and rebuilds after', async () => {
    clearAdminStatsCache()
    let builds = 0
    const build = async () => ++builds
    expect(await cachedAdminStats('k', build, 0)).toBe(1)
    expect(await cachedAdminStats('k', build, STATS_CACHE_TTL_MS - 1)).toBe(1)
    expect(await cachedAdminStats('k', build, STATS_CACHE_TTL_MS)).toBe(2)
  })

  it('forgets a failed build', async () => {
    clearAdminStatsCache()
    await expect(cachedAdminStats('f', () => Promise.reject(new Error('down')), 0)).rejects.toThrow('down')
    expect(await cachedAdminStats('f', async () => 'ok', 1)).toBe('ok')
  })

  it('clears itself before it grows past its cap', async () => {
    clearAdminStatsCache()
    for (let i = 0; i < 205; i++) await cachedAdminStats(`x${i}`, async () => i, 0)
    expect(await cachedAdminStats('x0', async () => -1, 0)).toBe(-1)
  })
})

describe('adminStatsQuery', () => {
  it('defaults to 30 days and ignores unknown values', () => {
    expect(adminStatsQuery.parse({})).toEqual({ range: '30', bucket: undefined })
    expect(adminStatsQuery.parse({ range: 'all', bucket: 'week' })).toEqual({ range: 'all', bucket: 'week' })
    expect(adminStatsQuery.parse({ range: '13', bucket: 'hour' })).toEqual({ range: '30', bucket: undefined })
  })
})

describe('estimated contribution', () => {
  const a = { taxPct: 8.1, paymentFeePct: 3.5, paymentFeeFixed: 0.3, eurChfRate: 0.9, usdChfRate: 0.8 }
  const g = (o: Partial<SubscriptionGroup>): SubscriptionGroup => ({ plan: 'pro', currency: 'chf', interval: 'month', subscriptions: 1, units: 1, ...o })

  it('takes tax, fees and the AI cost out of gross list revenue', () => {
    // CHF: 10 monthly Pro (90) + one yearly Team with 12 seats (120 x 12 / 12 = 120) = 210.
    const out = estimateContribution([g({ subscriptions: 10, units: 10 }), g({ plan: 'team', interval: 'year', units: 12 })], DEFAULT_PLAN_PRICES, a, 10)
    const chf = out.perCurrency[0]!
    expect(chf.gross).toBe(210)
    expect(chf.tax).toBeCloseTo(210 * 8.1 / 108.1, 2)
    // 3.5 % of 210 + 0.30 x (10 monthly charges + 1/12 yearly charge).
    expect(chf.fees).toBeCloseTo(7.35 + 0.3 * (10 + 1 / 12), 1)
    expect(chf.net).toBeCloseTo(210 - chf.tax - chf.fees, 1)
    expect(out.combinedChf.aiCost).toBe(8)
    expect(out.combinedChf.contribution).toBeCloseTo(chf.net - 8, 1)
  })

  it('converts EUR to CHF for the combined figures', () => {
    const out = estimateContribution([g({ currency: 'eur' })], DEFAULT_PLAN_PRICES, { ...a, taxPct: 0, paymentFeePct: 0, paymentFeeFixed: 0 }, 0)
    expect(out.combinedChf).toEqual({ gross: 8.1, tax: 0, fees: 0, net: 8.1, aiCost: 0, contribution: 8.1 })
    expect(combinedRevenueChf([{ currency: 'eur', mrr: 10, arr: 120 }, { currency: 'chf', mrr: 5, arr: 60 }], a)).toEqual({ mrr: 14, arr: 168 })
  })
})

describe('subscription history steps', () => {
  const sub = (o: Record<string, unknown> = {}) => ({ id: 'sub_1', cancel_at: null, cancel_at_period_end: false, items: { data: [] }, ...o })
  const ev = (type: string, object: Record<string, unknown>, previous?: Record<string, unknown>) =>
    ({ id: 'evt', type, created: 1, data: { object, previous_attributes: previous } }) as unknown as Parameters<typeof subscriptionEventKinds>[0]

  it('maps the subscription events to lifecycle steps', () => {
    expect(subscriptionEventKinds(ev('customer.subscription.created', sub()))).toEqual(['started'])
    expect(subscriptionEventKinds(ev('customer.subscription.deleted', sub()))).toEqual(['ended'])
    expect(subscriptionEventKinds(ev('customer.subscription.updated', sub({ cancel_at: 2000000000 }), { cancel_at: null }))).toEqual(['cancel_scheduled'])
    expect(subscriptionEventKinds(ev('customer.subscription.updated', sub(), { cancel_at: 5 }))).toEqual(['cancel_revoked'])
    expect(subscriptionEventKinds(ev('customer.subscription.updated', sub(), { items: {} }))).toEqual(['changed'])
    expect(subscriptionEventKinds(ev('customer.subscription.updated', sub(), { current_period_end: 1 }))).toEqual([])
    expect(subscriptionEventKinds(ev('customer.subscription.updated', sub()))).toEqual([])
  })

  it('rolls up only finished days the raw logs fully cover', () => {
    expect(rollupWindow(NOW)).toEqual({ from: '2026-08-21', to: '2026-11-16' })
  })
})
