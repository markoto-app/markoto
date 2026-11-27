import { beforeEach, describe, expect, it, vi } from 'vitest'
import { stubEnv } from '../../helpers/env'
import { funnelRows, stepConversion, stepExceedsPrevious, type StatsWindow } from '../../../shared/contracts/adminStats'

// Assembly of the admin's "Funnel by source" (server/utils/adminStats/funnelStats.ts)
// and its arithmetic (shared/contracts/adminStats.ts). The SQL is in
// tests/repos/acquisitionFunnel.test.ts.

const repos = vi.hoisted(() => ({
  acquisitionFunnel: vi.fn(async () => [] as Array<{ source: string, documents: number, signups: number, checkouts: number, paid: number }>),
  landingVisits: vi.fn(async () => [] as Array<{ query: string | null, referrerDomain: string | null, visits: number }>)
}))
vi.mock('../../../server/repos/productStats', () => ({ acquisitionFunnel: repos.acquisitionFunnel }))
vi.mock('../../../server/repos/umamiVisits', () => ({ landingVisits: repos.landingVisits }))

const { buildFunnelStats, dbCountsBySource, visitsBySource } = await import('../../../server/utils/adminStats/funnelStats')
const { adminAs } = await import('../../helpers/access')

const W: StatsWindow = { range: '7', from: '2027-01-10', to: '2027-01-17', prevFrom: '2027-01-03', bucket: 'day' }

describe('funnel arithmetic', () => {
  it('fills every source, sums the total and converts step to step', () => {
    const { rows, total } = funnelRows({ producthunt: { visits: 200, documents: 50, signups: 20, checkouts: 4, paid: 1 }, direct: { documents: 5 } }, true)
    expect(rows.map(r => r.source)).toEqual(['producthunt', 'hackernews', 'google', 'github', 'other', 'direct'])
    expect(rows[1]).toEqual({ source: 'hackernews', visits: 0, documents: 0, signups: 0, checkouts: 0, paid: 0 })
    expect(total).toEqual({ source: 'all', visits: 200, documents: 55, signups: 20, checkouts: 4, paid: 1 })
    const ph = rows[0]!
    expect(stepConversion(ph, 'visits')).toBeNull()
    expect(stepConversion(ph, 'documents')).toBe(25)
    expect(stepConversion(ph, 'signups')).toBe(40)
    expect(stepConversion(ph, 'paid')).toBe(25)
    expect(stepConversion(rows[1]!, 'documents')).toBeNull()
  })

  it('shows no share where a step outgrows the one before (undercounted visits)', () => {
    // Staging: 1 visit, 65 first documents: 6500 % would mean nothing.
    const row = { source: 'all' as const, visits: 1, documents: 65, signups: 65, checkouts: 2, paid: 3 }
    expect(stepConversion(row, 'documents')).toBeNull()
    expect(stepExceedsPrevious(row, 'documents')).toBe(true)
    // Equal steps are a real 100 %.
    expect(stepConversion(row, 'signups')).toBe(100)
    expect(stepExceedsPrevious(row, 'signups')).toBe(false)
    expect(stepConversion(row, 'checkouts')).toBeCloseTo(3.1, 5)
    expect(stepConversion(row, 'paid')).toBeNull()
    expect(stepExceedsPrevious(row, 'paid')).toBe(true)
    // The first step and unknown visits never exceed anything.
    expect(stepExceedsPrevious(row, 'visits')).toBe(false)
    expect(stepExceedsPrevious({ ...row, visits: null }, 'documents')).toBe(false)
    // A zero step before has no share; it counts as exceeded only when this step is above it.
    const zero = { ...row, visits: 0 }
    expect(stepConversion(zero, 'documents')).toBeNull()
    expect(stepExceedsPrevious(zero, 'documents')).toBe(true)
    expect(stepExceedsPrevious({ ...zero, documents: 0 }, 'documents')).toBe(false)
  })

  it('without visits the first step is unknown, not zero', () => {
    const { rows, total } = funnelRows({ google: { documents: 3 } }, false)
    expect(rows[2]!.visits).toBeNull()
    expect(total.visits).toBeNull()
    expect(stepConversion(rows[2]!, 'documents')).toBeNull()
  })
})

describe('funnel assembly', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    stubEnv({ NUXT_PUBLIC_ANALYTICS_WEBSITE_ID: '0d2c6a3e-1b4f-4a8e-9c0d-123456789abc', NUXT_SITE_URL: 'https://markoto.app' })
  })

  it('classifies Umami landings like the browser', () => {
    expect(visitsBySource([
      { query: 'ref=producthunt', referrerDomain: null, visits: 10 },
      { query: 'utm_source=hn&utm_medium=social', referrerDomain: null, visits: 2 },
      { query: null, referrerDomain: 'www.producthunt.com', visits: 3 },
      { query: '', referrerDomain: 'markoto.app', visits: 4 },
      { query: null, referrerDomain: null, visits: 1 },
      { query: null, referrerDomain: 'reddit.com', visits: 5 }
    ], 'markoto.app')).toEqual({ producthunt: 13, hackernews: 2, direct: 5, other: 5 })
  })

  it('folds direct and unknown database sources into direct', () => {
    expect(dbCountsBySource([
      { source: 'direct', documents: 1, signups: 2, checkouts: 0, paid: 0 },
      { source: 'retired-source', documents: 1, signups: 0, checkouts: 0, paid: 0 },
      { source: 'github', documents: 3, signups: 1, checkouts: 1, paid: 1 }
    ])).toEqual({ direct: { documents: 2, signups: 2, checkouts: 0, paid: 0 }, github: { documents: 3, signups: 1, checkouts: 1, paid: 1 } })
  })

  it('joins the database counts with Umami\'s visits', async () => {
    repos.acquisitionFunnel.mockResolvedValueOnce([{ source: 'producthunt', documents: 30, signups: 10, checkouts: 2, paid: 1 }])
    repos.landingVisits.mockResolvedValueOnce([{ query: 'ref=producthunt', referrerDomain: null, visits: 120 }])
    const admin = adminAs(1)
    const stats = await buildFunnelStats(admin, W)
    expect(repos.landingVisits).toHaveBeenCalledWith(admin, '0d2c6a3e-1b4f-4a8e-9c0d-123456789abc', W.from, W.to)
    expect(stats.trackingEnabled).toBe(true)
    expect(stats.visitsAvailable).toBe(true)
    expect(stats.rows[0]).toEqual({ source: 'producthunt', visits: 120, documents: 30, signups: 10, checkouts: 2, paid: 1 })
    expect(stats.total.visits).toBe(120)
  })

  it('still answers from the database when Umami cannot be read or is off', async () => {
    repos.landingVisits.mockRejectedValueOnce(new Error('no umami'))
    const broken = await buildFunnelStats(adminAs(1), W)
    expect(broken.visitsAvailable).toBe(false)
    expect(broken.total.visits).toBeNull()

    stubEnv({ NUXT_PUBLIC_ANALYTICS_WEBSITE_ID: undefined })
    const off = await buildFunnelStats(adminAs(1), W)
    expect(off.trackingEnabled).toBe(false)
    expect(off.visitsAvailable).toBe(false)
    expect(repos.landingVisits).toHaveBeenCalledTimes(1)
  })
})
