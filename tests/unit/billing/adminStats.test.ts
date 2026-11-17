import { describe, it, expect } from 'vitest'
import {
  defaultBucket, isoDay, pct, percentChange, recurringRevenue, round2, statsWindow, type SubscriptionGroup
} from '../../../shared/contracts/adminStats'
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
    expect(spendLogFloor(statsWindow('365', NOW, null))).toBe('2026-08-20')
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
