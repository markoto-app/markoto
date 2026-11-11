import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type {
  getStripeCatalogue } from '../../../server/utils/billing/stripePrices'
import {
  identifyStripePrice,
  livePlanPriceTable,
  lookupKeyPrefix,
  parsePriceIdOverrides,
  resetStripeCatalogueCache,
  stripePriceIdFor
} from '../../../server/utils/billing/stripePrices'
import { DEFAULT_PLAN_PRICES } from '../../../shared/config/pricing'

// The Stripe price catalogue (pricing plan WP2): lookup keys, the
// NUXT_STRIPE_PRICE_IDS overrides, batching, caching.

function fakeStripe(prices: Array<{ id: string, lookup_key: string, unit_amount: number }>) {
  const list = vi.fn(async (params: { lookup_keys: string[] }) => ({
    data: prices.filter(p => params.lookup_keys.includes(p.lookup_key))
  }))
  return { stripe: { prices: { list } } as unknown as Parameters<typeof getStripeCatalogue>[0], list }
}

beforeEach(() => resetStripeCatalogueCache())
afterEach(() => {
  vi.unstubAllEnvs()
  resetStripeCatalogueCache()
})

describe('lookup key prefix + overrides', () => {
  it('defaults to markoto and accepts a sane custom prefix only', () => {
    expect(lookupKeyPrefix({})).toBe('markoto')
    expect(lookupKeyPrefix({ NUXT_STRIPE_LOOKUP_KEY_PREFIX: 'staging' })).toBe('staging')
    expect(lookupKeyPrefix({ NUXT_STRIPE_LOOKUP_KEY_PREFIX: 'bad prefix!' })).toBe('markoto')
  })

  it('parses key=id pairs and skips foreign keys and junk', () => {
    const map = parsePriceIdOverrides('markoto_pro_month_eur=price_a, markoto_team_year_chf = price_b,garbage,markoto_x_month_eur=price_c,=price_d', 'markoto')
    expect([...map.keys()]).toEqual(['markoto_pro_month_eur', 'markoto_team_year_chf'])
    expect(map.get('markoto_team_year_chf')).toEqual({ plan: 'team', interval: 'year', currency: 'chf', priceId: 'price_b' })
  })
})

describe('catalogue', () => {
  it('looks prices up by lookup key in batches of at most 10 and caches the result', async () => {
    const { stripe, list } = fakeStripe([
      { id: 'price_pro_m_eur', lookup_key: 'markoto_pro_month_eur', unit_amount: 900 },
      { id: 'price_team_y_chf', lookup_key: 'markoto_team_year_chf', unit_amount: 13000 }
    ])
    expect(await stripePriceIdFor(stripe, 'pro', 'month', 'eur')).toBe('price_pro_m_eur')
    expect(await stripePriceIdFor(stripe, 'team', 'year', 'chf')).toBe('price_team_y_chf')
    expect(await stripePriceIdFor(stripe, 'business', 'month', 'eur')).toBeNull()
    for (const call of list.mock.calls) expect(call[0].lookup_keys.length).toBeLessThanOrEqual(10)
    expect(list).toHaveBeenCalledTimes(2) // 12 keys → 10 + 2, then cached
  })

  it('lets NUXT_STRIPE_PRICE_IDS win and skips looking those keys up', async () => {
    vi.stubEnv('NUXT_STRIPE_PRICE_IDS', 'markoto_pro_month_eur=price_override')
    const { stripe, list } = fakeStripe([{ id: 'price_from_stripe', lookup_key: 'markoto_pro_month_eur', unit_amount: 900 }])
    expect(await stripePriceIdFor(stripe, 'pro', 'month', 'eur')).toBe('price_override')
    for (const call of list.mock.calls) expect(call[0].lookup_keys).not.toContain('markoto_pro_month_eur')
  })

  it('identifies a price by override id, then lookup key, then catalogue', async () => {
    vi.stubEnv('NUXT_STRIPE_PRICE_IDS', 'markoto_business_year_eur=price_biz')
    const { stripe } = fakeStripe([{ id: 'price_only_in_stripe', lookup_key: 'markoto_team_month_chf', unit_amount: 1200 }])
    expect(await identifyStripePrice(null, { id: 'price_biz' })).toEqual({ plan: 'business', interval: 'year', currency: 'eur' })
    expect(await identifyStripePrice(null, { id: 'x', lookup_key: 'markoto_pro_year_chf' })).toEqual({ plan: 'pro', interval: 'year', currency: 'chf' })
    expect(await identifyStripePrice(stripe, { id: 'price_only_in_stripe' })).toEqual({ plan: 'team', interval: 'month', currency: 'chf' })
    expect(await identifyStripePrice(stripe, { id: 'price_unknown' })).toBeNull()
    expect(await identifyStripePrice(null, null)).toBeNull()
  })

  it('serves Stripe amounts on the live price table, planned amounts elsewhere', async () => {
    const { stripe } = fakeStripe([{ id: 'p', lookup_key: 'markoto_pro_month_chf', unit_amount: 1050 }])
    const table = await livePlanPriceTable(stripe)
    expect(table.chf.pro.month).toBe(10.5)
    expect(table.eur.pro.month).toBe(DEFAULT_PLAN_PRICES.eur.pro.month)
  })

  it('keeps going when Stripe errors (logs, no throw)', async () => {
    const list = vi.fn(async () => {
      throw new Error('boom')
    })
    const stripe = { prices: { list } } as unknown as Parameters<typeof getStripeCatalogue>[0]
    expect(await stripePriceIdFor(stripe, 'pro', 'month', 'eur')).toBeNull()
  })
})
