import { describe, it, expect } from 'vitest'
import {
  BILLING_INTERVALS,
  CURRENCIES,
  DEFAULT_PLAN_PRICES,
  PAID_PLAN_NAMES,
  allStripePriceLookupKeys,
  defaultCurrencyForLocale,
  parseStripePriceLookupKey,
  resolvePlanPricesFromEnv,
  stripePriceLookupKey
} from '../../../shared/config/pricing'
import { formatPlanBytes, formatPrice } from '../../../app/utils/billing/pricing'

// Plan prices: EUR + CHF, monthly + annual; one table
// for the cards, the comparison table and the Offer JSON-LD, and the
// Stripe lookup keys the server sells from.

describe('planned plan prices', () => {
  it('has every currency × paid plan × interval, positive and ascending by plan', () => {
    for (const currency of CURRENCIES) {
      for (const interval of BILLING_INTERVALS) {
        const row = PAID_PLAN_NAMES.map(plan => DEFAULT_PLAN_PRICES[currency][plan][interval])
        expect(row.every(p => p > 0), `${currency}/${interval}`).toBe(true)
        expect([...row].sort((a, b) => a - b), `${currency}/${interval}`).toEqual(row)
      }
    }
  })

  it('makes annual cheaper than twelve months', () => {
    for (const currency of CURRENCIES) {
      for (const plan of PAID_PLAN_NAMES) {
        const p = DEFAULT_PLAN_PRICES[currency][plan]
        expect(p.year, `${currency}/${plan}`).toBeLessThan(p.month * 12)
      }
    }
  })

  it('takes positive TIER_<PLAN>_PRICE_<CUR>[_YEAR] overrides, refuses invalid ones', () => {
    const prices = resolvePlanPricesFromEnv({
      TIER_PRO_PRICE_EUR: '12',
      TIER_PRO_PRICE_CHF_YEAR: '99',
      TIER_TEAM_PRICE_EUR: '',
      TIER_FREE_PRICE_EUR: '5'
    })
    expect(prices.eur.pro.month).toBe(12)
    expect(prices.chf.pro.year).toBe(99)
    expect(prices.eur.team.month).toBe(DEFAULT_PLAN_PRICES.eur.team.month)
    // A typo must never make a plan free: boot validation refuses it.
    expect(() => resolvePlanPricesFromEnv({ TIER_TEAM_PRICE_EUR: '-1' })).toThrow(/TIER_TEAM_PRICE_EUR: expected a number > 0/)
    expect(() => resolvePlanPricesFromEnv({ TIER_BUSINESS_PRICE_CHF: 'abc' })).toThrow(/TIER_BUSINESS_PRICE_CHF/)
  })

  it('returns the defaults without overrides and never mutates them', () => {
    const before = JSON.stringify(DEFAULT_PLAN_PRICES)
    expect(resolvePlanPricesFromEnv({})).toEqual(DEFAULT_PLAN_PRICES)
    resolvePlanPricesFromEnv({ TIER_PRO_PRICE_EUR: '50' })
    expect(JSON.stringify(DEFAULT_PLAN_PRICES)).toBe(before)
  })

  it('preselects CHF for Swiss locales only', () => {
    expect(defaultCurrencyForLocale('de-CH')).toBe('chf')
    expect(defaultCurrencyForLocale('fr_CH')).toBe('chf')
    expect(defaultCurrencyForLocale('de-DE')).toBe('eur')
    expect(defaultCurrencyForLocale('en')).toBe('eur')
    expect(defaultCurrencyForLocale(undefined)).toBe('eur')
  })
})

describe('Stripe price lookup keys', () => {
  it('round-trips plan / interval / currency', () => {
    for (const key of allStripePriceLookupKeys()) {
      const id = parseStripePriceLookupKey(key)
      expect(id, key).not.toBeNull()
      expect(stripePriceLookupKey(id!.plan, id!.interval, id!.currency)).toBe(key)
    }
    expect(allStripePriceLookupKeys()).toHaveLength(CURRENCIES.length * PAID_PLAN_NAMES.length * BILLING_INTERVALS.length)
  })

  it('honours a custom prefix and rejects foreign or malformed keys', () => {
    expect(parseStripePriceLookupKey('staging_pro_year_chf', 'staging')).toEqual({ plan: 'pro', interval: 'year', currency: 'chf' })
    expect(parseStripePriceLookupKey('markoto_pro_year_chf', 'staging')).toBeNull()
    expect(parseStripePriceLookupKey('markoto_free_month_eur')).toBeNull()
    expect(parseStripePriceLookupKey('markoto_pro_week_eur')).toBeNull()
    expect(parseStripePriceLookupKey('markoto_pro_month_usd')).toBeNull()
    expect(parseStripePriceLookupKey('markoto_pro_month_eur_extra')).toBeNull()
    expect(parseStripePriceLookupKey(null)).toBeNull()
  })
})

describe('pricing formatters', () => {
  it('formats whole prices without decimals and fractional ones with two', () => {
    expect(formatPrice(10, 'EUR', 'en')).toBe('€10')
    expect(formatPrice(12.5, 'EUR', 'en')).toBe('€12.50')
    expect(formatPrice(9, 'CHF', 'de-CH')).toMatch(/CHF\s?9/)
  })

  it('formats plan byte caps as MB or GB', () => {
    expect(formatPlanBytes(100 * 1024 * 1024)).toBe('100 MB')
    expect(formatPlanBytes(2 * 1024 * 1024 * 1024)).toBe('2 GB')
    expect(formatPlanBytes(1.5 * 1024 * 1024 * 1024)).toBe('1.5 GB')
  })
})
