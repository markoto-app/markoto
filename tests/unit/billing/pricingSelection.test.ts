import { describe, expect, it } from 'vitest'
import { pricingPathFor, pricingSelectionFromQuery, type PricingSelection } from '../../../app/utils/billing/pricing'

// The pricing page's choice in a link: the page a sign-in from /pricing
// returns to carries it, so signing in keeps the billing period,
// currency and Teams plan + seats the visitor picked.

const DEFAULTS: PricingSelection = { interval: 'month', currency: 'eur', teamPlan: 'team', seats: 3 }

describe('pricingSelectionFromQuery', () => {
  it('reads every valid value', () => {
    expect(pricingSelectionFromQuery({ interval: 'year', currency: 'chf', plan: 'business', seats: '12' }))
      .toEqual({ interval: 'year', currency: 'chf', teamPlan: 'business', seats: 12 })
  })

  it('leaves out missing, unknown and out-of-range values', () => {
    expect(pricingSelectionFromQuery({})).toEqual({})
    expect(pricingSelectionFromQuery({ interval: 'week', currency: 'usd', plan: 'pro', seats: '2' })).toEqual({})
    expect(pricingSelectionFromQuery({ seats: '1001' })).toEqual({})
    expect(pricingSelectionFromQuery({ seats: '5.5' })).toEqual({})
    expect(pricingSelectionFromQuery({ interval: ['year'], seats: ['5'] })).toEqual({})
  })
})

describe('pricingPathFor', () => {
  it('keeps the plain page clean for the defaults', () => {
    expect(pricingPathFor('/pricing', DEFAULTS, DEFAULTS)).toBe('/pricing')
  })

  it('carries what differs from the defaults', () => {
    expect(pricingPathFor('/pricing', { ...DEFAULTS, interval: 'year' }, DEFAULTS)).toBe('/pricing?interval=year')
    expect(pricingPathFor('/de/pricing', { interval: 'year', currency: 'chf', teamPlan: 'business', seats: 7 }, DEFAULTS))
      .toBe('/de/pricing?interval=year&currency=chf&plan=business&seats=7')
  })

  it('a Swiss browser\'s CHF default is not carried, its EUR choice is', () => {
    const swiss = { ...DEFAULTS, currency: 'chf' as const }
    expect(pricingPathFor('/pricing', swiss, swiss)).toBe('/pricing')
    expect(pricingPathFor('/pricing', DEFAULTS, swiss)).toBe('/pricing?currency=eur')
  })

  it('round-trips through the query', () => {
    const selection: PricingSelection = { interval: 'year', currency: 'chf', teamPlan: 'business', seats: 9 }
    const query = Object.fromEntries(new URL(pricingPathFor('/pricing', selection, DEFAULTS), 'http://x').searchParams)
    expect(pricingSelectionFromQuery(query)).toEqual(selection)
  })
})
