import { describe, it, expect } from 'vitest'
import {
  DEFAULT_PLAN_PRICES_USD,
  PAID_PLAN_NAMES,
  PRICE_CURRENCY,
  resolvePlanPricesFromEnv
} from '../../shared/config/pricing'
import { PLAN_NAMES } from '../../shared/config/tiers'
import { formatPlanBytes, formatPrice } from '../../app/utils/pricing'

// Plan prices on /pricing: one config for the cards, the comparison
// table and the Offer JSON-LD, overridable per paid plan.

describe('plan prices', () => {
  it('has a price for every plan, free at 0 and paid plans ascending', () => {
    for (const plan of PLAN_NAMES) expect(typeof DEFAULT_PLAN_PRICES_USD[plan], plan).toBe('number')
    expect(DEFAULT_PLAN_PRICES_USD.free).toBe(0)
    const paid = PAID_PLAN_NAMES.map(plan => DEFAULT_PLAN_PRICES_USD[plan])
    expect(paid.every(p => p > 0)).toBe(true)
    expect([...paid].sort((a, b) => a - b)).toEqual(paid)
  })

  it('is in US dollars', () => {
    expect(PRICE_CURRENCY).toBe('USD')
  })

  it('takes positive TIER_<PLAN>_PRICE_USD overrides and ignores anything else', () => {
    const prices = resolvePlanPricesFromEnv({
      TIER_PRO_PRICE_USD: '12',
      TIER_MAX_PRICE_USD: '-1',
      TIER_ULTRA_PRICE_USD: 'abc',
      TIER_FREE_PRICE_USD: '5'
    })
    expect(prices.pro).toBe(12)
    expect(prices.max).toBe(DEFAULT_PLAN_PRICES_USD.max)
    expect(prices.ultra).toBe(DEFAULT_PLAN_PRICES_USD.ultra)
    // A free account never costs money.
    expect(prices.free).toBe(0)
  })

  it('returns the defaults without overrides', () => {
    expect(resolvePlanPricesFromEnv({})).toEqual(DEFAULT_PLAN_PRICES_USD)
  })
})

describe('pricing formatters', () => {
  it('formats whole prices without decimals and fractional ones with two', () => {
    expect(formatPrice(10, 'USD', 'en')).toBe('$10')
    expect(formatPrice(12.5, 'USD', 'en')).toBe('$12.50')
  })

  it('formats plan byte caps as MB or GB', () => {
    expect(formatPlanBytes(100 * 1024 * 1024)).toBe('100 MB')
    expect(formatPlanBytes(2 * 1024 * 1024 * 1024)).toBe('2 GB')
    expect(formatPlanBytes(1.5 * 1024 * 1024 * 1024)).toBe('1.5 GB')
  })
})
