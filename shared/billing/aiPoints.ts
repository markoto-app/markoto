// AI Points conversion: pure helpers shared between server and client.
//
// "AI Points" is the user-facing display unit for the LiteLLM budget.
// Conversion is a fixed 1000:1 ratio: 1 AI Point = $0.001 USD of
// LiteLLM spend. Storing both backend USD math and frontend display
// math behind these helpers gives ONE place to change the ratio
// without touching every callsite.
//
// Why 1000:1: it makes plan numbers feel substantial without being
// dishonest: "$5 of model usage" is harder to internalise than
// "5000 AI Points". The math is transparent enough that a power user
// who divides by 1000 lands on the actual dollar amount.
//
// Plan tier mapping lives in `shared/config/tiers.ts`
// (tiers[plan].litellmBudgetUsd); `planToBudgetUsd` is a thin wrapper
// for callsites that don't already have a TierCaps reference handy.

import type { PlanName, TiersMap } from '../config/tiers'

const POINTS_PER_DOLLAR = 1000

/** $1.00 → 1000 AI Points. */
export function dollarsToPoints(usd: number): number {
  return Math.round(usd * POINTS_PER_DOLLAR)
}

/**
 * The full monthly USD budget for a plan. Used at virtual-key creation
 * time and on Stripe webhook plan changes.
 *
 * `tiers` is REQUIRED (no default) so every call site consciously
 * passes the RESOLVED map (server: `getTiers()`, client: the
 * `/api/billing/tiers` fetch): a defaulted param would silently miss
 * runtime `TIER_*` overrides.
 */
export function planToBudgetUsd(plan: PlanName, tiers: TiersMap): number {
  return tiers[plan].litellmBudgetUsd
}

/**
 * The full monthly AI Points allotment for a plan. Used by /api/ai/credits
 * to populate the `pointsTotal` field for the UI's progress ring.
 */
export function planToPointsTotal(plan: PlanName, tiers: TiersMap): number {
  return dollarsToPoints(tiers[plan].litellmBudgetUsd)
}

export interface AiPointsSplit {
  /** Everything still usable: plan budget and bought credits together. */
  pointsRemaining: number
  /** The plan's monthly allotment, without credits. */
  pointsTotal: number
  /** What is left of the plan's allotment; never above `pointsTotal`. */
  planPointsRemaining: number
  /** What is left beyond the plan's allotment: bought AI credits. */
  creditPoints: number
}

/**
 * Split a LiteLLM key's remaining budget into the plan's part and the
 * bought credits. The key's `max_budget` is plan budget + credits and the
 * plan budget is spent first, so what is left of the plan is
 * `planBudget - spend` (capped by what the key really has left, in case
 * the key's budget lags the plan) and credits are the remainder.
 */
export function splitPlanAndCreditPoints(args: { maxBudgetUsd: number, spendUsd: number, planBudgetUsd: number }): AiPointsSplit {
  const remainingUsd = Math.max(0, args.maxBudgetUsd - args.spendUsd)
  const planRemainingUsd = Math.min(remainingUsd, Math.max(0, args.planBudgetUsd - args.spendUsd))
  const pointsRemaining = dollarsToPoints(remainingUsd)
  const planPointsRemaining = dollarsToPoints(planRemainingUsd)
  return {
    pointsRemaining,
    pointsTotal: dollarsToPoints(args.planBudgetUsd),
    planPointsRemaining,
    creditPoints: pointsRemaining - planPointsRemaining
  }
}
