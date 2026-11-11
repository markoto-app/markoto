import { eq } from 'drizzle-orm'
import { users } from '../db/schema'
import { useDatabase } from './database'
import type { PlanName } from '~~/shared/config/tiers'
import { ensureUserKey } from './litellm/userKeys'
import { isBillingEnabled } from './billingMode'
import { getPooledWorkspace } from './workspaceBilling'
import { ensureMemberKey } from './litellm/workspaceTeams'
import { resolveUserPlan } from './entitlements'
import { getWorkspaceRole } from './workspaceAccess'

/**
 * Phase 6 billing context resolution. Every AI call site calls
 * `resolveBillingContext` once and threads the result through:
 *
 *   1. WHICH plan applies (capacity caps, tier display).
 *   2. WHO gets charged (today always the caller; Team workspaces in WP3).
 *   3. WHICH virtual key the LLM call should use as its bearer token.
 *
 * Phase 6 architecture: AI usage is gated SOLELY by per-user LiteLLM
 * virtual-key budgets. There's no app-side interaction counter,
 * BudgetExhausted exception, or `chargeInteractions` call — LiteLLM's
 * spend tracker enforces `max_budget` natively, and a budget overrun
 * surfaces as an HTTP 422 `budget_exceeded` from the proxy (400 before
 * LiteLLM 1.104; detection is message-based, not status-based). Callers
 * use `useLitellmForUser(virtualKey)` from `litellmClient.ts` and
 * catch `LitellmBudgetExhausted` (or detect via `isBudgetExceededError`)
 * at the call site.
 *
 * Period anchoring (Stripe `current_period_start` for paid users,
 * calendar-month UTC for free) is preserved — used by `/api/ai/credits`
 * to populate the AI Points UI's `periodEnd` display so users see when
 * their budget resets.
 */

/**
 * Identifier for the billing target. `user:{id}` or `workspace:{id}`.
 * Kept as a typed string for diagnostics + Sentry tags; no DB column
 * stores it post-Phase-6.
 */
export type AttributedTo = `user:${number}` | `workspace:${string}`

export interface BillingContext {
  /** The effective plan. Determines tier caps + UI display. */
  plan: PlanName
  /** Who gets billed — `user:{id}` or `workspace:{wsId}`. */
  attributedTo: AttributedTo
  /**
   * Start of the current billing period. Paid users: Stripe's
   * `current_period_start` (anniversary). Free users: first of the
   * current calendar month UTC.
   */
  periodStart: Date
  /**
   * End of the current billing period. Paid users: Stripe's
   * `current_period_end`. Free users: first of the next calendar
   * month UTC. Surfaced to the UI as "resets on {date}".
   */
  periodEnd: Date
  /**
   * The LiteLLM virtual-key bearer token for this billing target. Pass
   * to `useLitellmForUser(virtualKey)` to construct an OpenAI SDK
   * client whose calls debit this budget. Lazy-created on first use.
   */
  virtualKey: string
  /**
   * `'user'` = the caller's own key; `'workspace'` = the caller's key in a
   * Team / Business workspace's LiteLLM team (member limit + pool).
   */
  attribution: 'user' | 'workspace'
  /**
   * The user-id whose virtual key + spend the AI Points UI should
   * read. Equals `userId` for self-bill.
   */
  billingUserId: number
  /** The paying workspace when `attribution === 'workspace'`. */
  workspaceId?: string
}

/**
 * First day of the current calendar month, UTC, at 00:00:00.000.
 * Free users anchor their billing period here; paid users use their
 * Stripe anniversary via `effectivePeriodStart`.
 */
export function currentPeriodStart(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0))
}

/** First of the next calendar month, UTC. */
function nextCalendarMonthStart(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0))
}

/**
 * Resolve the billing-period start for a user.
 *
 *   - Free (or defensively-downgraded lapsed) → calendar-month UTC.
 *   - Active paid user with Stripe anchor set → that anchor.
 */
export function effectivePeriodStart(args: {
  plan: PlanName
  stripeCurrentPeriodStart: Date | null
  planValidUntil: Date | null
  now?: Date
}): Date {
  const now = args.now ?? new Date()
  if (!isPaidAndActive(args.plan, args.planValidUntil, args.stripeCurrentPeriodStart, now)) {
    return currentPeriodStart(now)
  }
  return args.stripeCurrentPeriodStart as Date
}

/**
 * End of the billing period. Paid + active → `planValidUntil`
 * (Stripe's `current_period_end`). Everything else → first of the
 * next calendar month.
 */
export function effectivePeriodEnd(args: {
  plan: PlanName
  stripeCurrentPeriodStart: Date | null
  planValidUntil: Date | null
  now?: Date
}): Date {
  const now = args.now ?? new Date()
  if (!isPaidAndActive(args.plan, args.planValidUntil, args.stripeCurrentPeriodStart, now)) {
    return nextCalendarMonthStart(now)
  }
  return args.planValidUntil as Date
}

/**
 * A user is on a paid anchor iff: plan is not free, has a future
 * `planValidUntil`, AND has a concrete Stripe `current_period_start`.
 * Any failure of those → fall back to the calendar anchor.
 */
function isPaidAndActive(
  plan: PlanName,
  planValidUntil: Date | null,
  stripeCurrentPeriodStart: Date | null,
  now: Date
): boolean {
  if (plan === 'free') return false
  if (planValidUntil === null || planValidUntil.getTime() <= now.getTime()) return false
  if (stripeCurrentPeriodStart === null) return false
  return true
}

/** Whether a stored plan is still active (free never lapses). */
function planActive(plan: PlanName, planValidUntil: Date | null, now: Date): boolean {
  if (plan === 'free') return true
  if (planValidUntil === null) return false
  return planValidUntil.getTime() > now.getTime()
}

async function getUserPlan(userId: number): Promise<{
  plan: PlanName
  planValidUntil: Date | null
  stripeCurrentPeriodStart: Date | null
} | null> {
  const db = useDatabase()
  const rows = await db.select({
    plan: users.plan,
    planValidUntil: users.planValidUntil,
    stripeCurrentPeriodStart: users.stripeCurrentPeriodStart
  }).from(users).where(eq(users.id, userId)).limit(1)
  const row = rows[0]
  if (!row) return null
  return {
    plan: row.plan,
    planValidUntil: row.planValidUntil,
    stripeCurrentPeriodStart: row.stripeCurrentPeriodStart
  }
}

/**
 * Resolve the billing context for an AI call: the caller's own virtual
 * key at their effective personal plan. Lapsed paid users collapse to
 * Free caps + Free's budget. (The retired `(+)` workspace sponsorship
 * path is gone; Team billing replaces it in WP3.)
 *
 * Lazy virtual-key creation: if the caller doesn't have a LiteLLM key
 * yet, `ensureUserKey` creates one inline.
 * One round-trip to LiteLLM admin per user lifetime.
 *
 * Throws if `userId` doesn't match any row — all callers go through
 * `requireValidatedUserSession` first, which rejects missing users
 * at 401 before the handler runs.
 */
export async function resolveBillingContext(
  userId: number,
  workspaceId: string | null | undefined
): Promise<BillingContext> {
  const now = new Date()

  const caller = await getUserPlan(userId)
  if (!caller) {
    throw new Error(`[billing] resolveBillingContext: user ${userId} not found`)
  }
  // Billing off (self-hosted / free-only SaaS): nobody can hold a paid
  // plan — everyone self-bills at the free tier (whose budget operators raise via TIER_FREE_* env vars).
  const billingOn = isBillingEnabled()
  const callerActive = planActive(caller.plan, caller.planValidUntil, now)
  // A lapsed paid user reverts to Free caps until the plan-lapse
  // sweep catches up. Prevents a Pro user whose card just failed
  // from still getting Pro quota.
  const effectiveCallerPlan: PlanName = billingOn && callerActive ? caller.plan : 'free'

  // TODO(WP3, Team billing): a member of a Team / Business workspace
  // bills to that workspace's pooled budget through their per-workspace
  // key. Until then every caller self-bills; `workspaceId` is accepted so
  // call sites don't change when that lands.
  // Team / Business (WP3): inside a workspace with an entitled
  // subscription a member's AI runs on their key in the workspace's
  // LiteLLM team (member limit + pooled team budget). Non-members (e.g.
  // someone editing an open-edit document of the workspace) keep their
  // own budget, as do members outside the workspace.
  const pool = billingOn ? await getPooledWorkspace(workspaceId, now) : null
  if (pool) {
    const memberKey = await ensureMemberKey(pool, userId)
    if (memberKey) {
      return {
        plan: pool.plan,
        attributedTo: `workspace:${pool.workspaceId}` as const,
        periodStart: pool.subscription.currentPeriodStart ?? currentPeriodStart(now),
        periodEnd: pool.subscription.validUntil ?? nextCalendarMonthStart(now),
        virtualKey: memberKey.token,
        attribution: 'workspace',
        billingUserId: userId,
        workspaceId: pool.workspaceId
      }
    }
  }

  const selfPeriodStart = effectivePeriodStart({
    plan: effectiveCallerPlan,
    stripeCurrentPeriodStart: caller.stripeCurrentPeriodStart,
    planValidUntil: caller.planValidUntil,
    now
  })
  const selfPeriodEnd = effectivePeriodEnd({
    plan: effectiveCallerPlan,
    stripeCurrentPeriodStart: caller.stripeCurrentPeriodStart,
    planValidUntil: caller.planValidUntil,
    now
  })
  const callerKey = await ensureUserKey(userId, effectiveCallerPlan)
  return {
    plan: effectiveCallerPlan,
    attributedTo: `user:${userId}` as const,
    periodStart: selfPeriodStart,
    periodEnd: selfPeriodEnd,
    virtualKey: callerKey.token,
    attribution: 'user',
    billingUserId: userId
  }
}

/**
 * The plan that pays for AI here, without touching LiteLLM: a Team /
 * Business workspace's plan for its members inside it, else the user's
 * effective personal plan. Same rule as `resolveBillingContext`.
 */
export async function resolvePayingPlan(userId: number, workspaceId: string | null | undefined): Promise<PlanName> {
  const pool = isBillingEnabled() ? await getPooledWorkspace(workspaceId) : null
  if (pool && (await getWorkspaceRole(userId, pool.workspaceId)) !== null) return pool.plan
  return resolveUserPlan(userId)
}
