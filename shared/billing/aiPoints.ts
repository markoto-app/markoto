// AI Points conversion — pure helpers shared between server and client.
//
// "AI Points" is the user-facing display unit for the LiteLLM budget.
// Conversion is a fixed 1000:1 ratio: 1 AI Point = $0.001 USD of
// LiteLLM spend. Storing both backend USD math and frontend display
// math behind these helpers gives ONE place to change the ratio
// without touching every callsite.
//
// Why 1000:1: it makes plan numbers feel substantial without being
// dishonest — "$5 of model usage" is harder to internalise than
// "5000 AI Points". The math is transparent enough that a power user
// who divides by 1000 lands on the actual dollar amount.
//
// Plan tier mapping lives in `shared/config/tiers.ts` (TIERS[plan].litellmBudgetUsd);
// `planToBudgetUsd` is a thin wrapper for callsites that don't already
// have a TierCaps reference handy.

import { TIERS, type PlanName } from '../config/tiers'

const POINTS_PER_DOLLAR = 1000

/** $1.00 → 1000 AI Points. */
export function dollarsToPoints(usd: number): number {
  return Math.round(usd * POINTS_PER_DOLLAR)
}

/** 5000 AI Points → $5.00. */
export function pointsToDollars(points: number): number {
  return points / POINTS_PER_DOLLAR
}

/**
 * The full monthly USD budget for a plan. Used at virtual-key creation
 * time and on Stripe webhook plan changes.
 */
export function planToBudgetUsd(plan: PlanName): number {
  return TIERS[plan].litellmBudgetUsd
}

/**
 * The full monthly AI Points allotment for a plan. Used by /api/ai/credits
 * to populate the `pointsTotal` field for the UI's progress ring.
 */
export function planToPointsTotal(plan: PlanName): number {
  return dollarsToPoints(TIERS[plan].litellmBudgetUsd)
}
