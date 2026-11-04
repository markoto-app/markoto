// Monthly plan prices shown on /pricing (and in its Offer JSON-LD).
//
// One source for the cards, the comparison table and the structured
// data, so they can't disagree. The price a customer is actually
// charged is the Stripe Price behind `NUXT_STRIPE_PRICE_{PRO,MAX,ULTRA}`;
// keep the two in step when billing is on.
//
// While paid plans are "coming soon" (billing off + NUXT_PLANS_COMING_SOON)
// these are the PLANNED prices: the page labels them as planned and the
// JSON-LD leaves them out (nothing can be bought at that price yet).
//
// Overridable at runtime like the tier caps, without a rebuild:
// `TIER_<PRO|MAX|ULTRA>_PRICE_USD`, e.g. `TIER_PRO_PRICE_USD=12`.

import { PLAN_NAMES, type PlanName } from './tiers'

/** Every price on the page is in this currency. */
export const PRICE_CURRENCY = 'USD'

export type PaidPlanName = Exclude<PlanName, 'free'>

export const PAID_PLAN_NAMES: readonly PaidPlanName[] = ['pro', 'max', 'ultra']

/** Monthly price per plan in whole or fractional US dollars. Free is always 0. */
export type PlanPrices = Record<PlanName, number>

export const DEFAULT_PLAN_PRICES_USD: PlanPrices = {
  free: 0,
  pro: 10,
  max: 50,
  ultra: 100
}

/** Shape of `GET /api/billing/prices`. */
export interface PlanPricesResponse {
  currency: typeof PRICE_CURRENCY
  monthly: PlanPrices
}

export function isPaidPlan(plan: PlanName): plan is PaidPlanName {
  return plan !== 'free'
}

/**
 * Resolve the effective prices from an env-shaped record. Pure. Only
 * positive finite numbers override a paid plan's default; Free can't be
 * overridden (a free account that costs money isn't a free account).
 */
export function resolvePlanPricesFromEnv(env: Record<string, string | undefined>): PlanPrices {
  const prices: PlanPrices = { ...DEFAULT_PLAN_PRICES_USD }
  for (const plan of PLAN_NAMES) {
    if (!isPaidPlan(plan)) continue
    const raw = env[`TIER_${plan.toUpperCase()}_PRICE_USD`]
    if (raw === undefined || raw.trim() === '') continue
    const value = Number(raw)
    if (Number.isFinite(value) && value > 0) prices[plan] = value
  }
  return prices
}
