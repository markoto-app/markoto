// Plan prices: the price table /pricing shows (cards, comparison table,
// Offer JSON-LD) and the Stripe price catalogue the server sells from.
//
// Prices are in EUR and CHF, monthly and annual. Team and Business are
// PER SEAT (`PER_SEAT_PLANS`).
//
// Two sources, one shape (`PlanPriceTable`):
//   - billing ON: the live Stripe Prices, found by LOOKUP KEY
//     (`stripePriceLookupKey`, e.g. `markoto_pro_year_chf`) —
//     server/utils/stripePrices.ts. The amounts on the page are then
//     exactly what Stripe charges.
//   - billing OFF ("coming soon"): the PLANNED prices below, labelled as
//     planned on the page and left out of the JSON-LD (nothing can be
//     bought yet). Overridable at runtime without a rebuild:
//     `TIER_<PRO|TEAM|BUSINESS>_PRICE_<EUR|CHF>` (monthly) and
//     `..._<EUR|CHF>_YEAR` (annual), e.g. `TIER_PRO_PRICE_CHF=10`.

import type { PlanName } from './tiers'

export const CURRENCIES = ['eur', 'chf'] as const
export type Currency = typeof CURRENCIES[number]

export const BILLING_INTERVALS = ['month', 'year'] as const
export type BillingInterval = typeof BILLING_INTERVALS[number]

export type PaidPlanName = Exclude<PlanName, 'free'>

export const PAID_PLAN_NAMES: readonly PaidPlanName[] = ['pro', 'team', 'business']

/** Plans priced per seat (workspace subscriptions). */
const PER_SEAT_PLANS: readonly PaidPlanName[] = ['team', 'business']

export function isPerSeatPlan(plan: PlanName): boolean {
  return (PER_SEAT_PLANS as readonly PlanName[]).includes(plan)
}

export function isCurrency(value: unknown): value is Currency {
  return typeof value === 'string' && (CURRENCIES as readonly string[]).includes(value)
}

export function isBillingInterval(value: unknown): value is BillingInterval {
  return typeof value === 'string' && (BILLING_INTERVALS as readonly string[]).includes(value)
}

/** One plan's price per interval, in whole currency units (e.g. 9 = €9). */
export type IntervalPrices = Record<BillingInterval, number>

/** Every paid plan's prices in every currency. */
export type PlanPriceTable = Record<Currency, Record<PaidPlanName, IntervalPrices>>

/** Planned prices (billing off). Annual = 10 × monthly: two months free. */
export const DEFAULT_PLAN_PRICES: PlanPriceTable = {
  eur: {
    pro: { month: 9, year: 90 },
    team: { month: 12, year: 120 },
    business: { month: 20, year: 200 }
  },
  chf: {
    pro: { month: 9, year: 90 },
    team: { month: 12, year: 120 },
    business: { month: 20, year: 200 }
  }
}

/** Shape of `GET /api/billing/prices`. */
export interface PlanPricesResponse {
  currencies: readonly Currency[]
  prices: PlanPriceTable
  /** `stripe` = live prices someone can pay now; `planned` = coming soon. */
  source: 'stripe' | 'planned'
}

/**
 * Stripe Price lookup key for a plan / interval / currency. The operator
 * creates one recurring Price per key in the Stripe dashboard
 * (docs/LAUNCH-CHECKLIST.md); the server finds them by key, so prices
 * change in Stripe without a deploy.
 */
export function stripePriceLookupKey(plan: PaidPlanName, interval: BillingInterval, currency: Currency, prefix = 'markoto'): string {
  return `${prefix}_${plan}_${interval}_${currency}`
}

export interface PriceIdentity {
  plan: PaidPlanName
  interval: BillingInterval
  currency: Currency
}

/** Parse a lookup key back into plan / interval / currency (`null` = not ours). */
export function parseStripePriceLookupKey(key: string | null | undefined, prefix = 'markoto'): PriceIdentity | null {
  if (!key || !key.startsWith(`${prefix}_`)) return null
  const [plan, interval, currency, ...rest] = key.slice(prefix.length + 1).split('_')
  if (rest.length > 0) return null
  if (!(PAID_PLAN_NAMES as readonly string[]).includes(plan ?? '')) return null
  if (!isBillingInterval(interval) || !isCurrency(currency)) return null
  return { plan: plan as PaidPlanName, interval, currency }
}

/** Every lookup key the catalogue sells. */
export function allStripePriceLookupKeys(prefix = 'markoto'): string[] {
  const keys: string[] = []
  for (const currency of CURRENCIES) {
    for (const plan of PAID_PLAN_NAMES) {
      for (const interval of BILLING_INTERVALS) keys.push(stripePriceLookupKey(plan, interval, currency, prefix))
    }
  }
  return keys
}

/**
 * Resolve the planned prices from an env-shaped record. Pure. Only
 * positive finite numbers override a price; anything else keeps the
 * default (a typo must never make a plan free or broken).
 */
export function resolvePlanPricesFromEnv(env: Record<string, string | undefined>): PlanPriceTable {
  const table = structuredClone(DEFAULT_PLAN_PRICES)
  for (const currency of CURRENCIES) {
    for (const plan of PAID_PLAN_NAMES) {
      for (const interval of BILLING_INTERVALS) {
        const name = `TIER_${plan.toUpperCase()}_PRICE_${currency.toUpperCase()}${interval === 'year' ? '_YEAR' : ''}`
        const raw = env[name]
        if (raw === undefined || raw.trim() === '') continue
        const value = Number(raw)
        if (Number.isFinite(value) && value > 0) table[currency][plan][interval] = value
      }
    }
  }
  return table
}

/**
 * The currency a visitor most likely pays in: CHF for Swiss locales
 * (`de-CH`, `fr-CH`, `it-CH`, …), EUR otherwise. The pricing page lets
 * them switch.
 */
export function defaultCurrencyForLocale(locale: string | null | undefined): Currency {
  return /[-_]ch$/i.test(locale ?? '') ? 'chf' : 'eur'
}

// ─── AI credit top-ups (WP4) ────────────────────────────────────────
//
// One-time purchases that raise a Pro user's or a Team / Business
// workspace's AI budget. Each pack adds `creditUsd` (the AI budget is
// metered in USD by LiteLLM) and costs `price` in the buyer's currency;
// credits expire `TOPUP_VALIDITY_MONTHS` after purchase. Sold through
// one-time Stripe Prices with the lookup key
// `<prefix>_topup_<pack>_<eur|chf>` (`stripeTopupLookupKey`).

export const TOPUP_PACK_IDS = ['10', '25', '50'] as const
export type TopupPackId = typeof TOPUP_PACK_IDS[number]

export interface TopupPack {
  id: TopupPackId
  creditUsd: number
  price: Record<Currency, number>
}

export const TOPUP_PACKS: readonly TopupPack[] = [
  { id: '10', creditUsd: 10, price: { eur: 10, chf: 10 } },
  { id: '25', creditUsd: 25, price: { eur: 25, chf: 25 } },
  { id: '50', creditUsd: 50, price: { eur: 50, chf: 50 } }
]

export const TOPUP_VALIDITY_MONTHS = 12

export function isTopupPackId(value: unknown): value is TopupPackId {
  return typeof value === 'string' && (TOPUP_PACK_IDS as readonly string[]).includes(value)
}

export function topupPack(id: TopupPackId): TopupPack {
  return TOPUP_PACKS.find(p => p.id === id)!
}

export function stripeTopupLookupKey(pack: TopupPackId, currency: Currency, prefix = 'markoto'): string {
  return `${prefix}_topup_${pack}_${currency}`
}

/** 400 code of a purchase sent without accepting the Paid Plans Terms (WP6b). */
export const PAID_TERMS_REQUIRED_CODE = 'billing/terms-required'
