import { eq } from 'drizzle-orm'
import { users, workspaces } from '../db/schema'
import { useDatabase } from './database'
import type { PlanName } from '~~/shared/config/tiers'
import { ensureUserKey } from './litellmKeys'

/**
 * Phase 6 billing context resolution. Every AI call site calls
 * `resolveBillingContext` once and threads the result through:
 *
 *   1. WHICH plan applies (capacity caps, tier display).
 *   2. WHO gets charged — the caller or a `(+)` workspace's sponsor.
 *   3. WHICH virtual key the LLM call should use as its bearer token.
 *
 * Phase 6 architecture: AI usage is gated SOLELY by per-user LiteLLM
 * virtual-key budgets. There's no app-side interaction counter,
 * BudgetExhausted exception, or `chargeInteractions` call — LiteLLM's
 * spend tracker enforces `max_budget` natively, and a budget overrun
 * surfaces as an HTTP 400 `budget_exceeded` from the proxy. Callers
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
   * For diagnostics: `'workspace'` = `(+)` active and sponsor covers
   * the caller; `'user'` = self-bill.
   */
  attribution: 'user' | 'workspace'
  /**
   * The user-id whose virtual key + spend the AI Points UI should
   * read. Equals `userId` for self-bill; equals the workspace
   * `billingOwnerId` (sponsor) when `(+)` is active. Lets credits.get
   * call `getUserKeyInfo(billingUserId, plan)` without re-deriving
   * the sponsor.
   */
  billingUserId: number
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

/**
 * Whether a plan can sponsor `(+)` team-billing. Only Max and Ultra —
 * Pro is personal-only. Free is never a sponsor target.
 */
function supportsTeamBilling(plan: PlanName): boolean {
  return plan === 'max' || plan === 'ultra'
}

/**
 * Same check as `isPaidAndActive` but exposed as a plain predicate on
 * the plan + expiry alone (used when resolving (+) sponsor
 * eligibility — we still want a valid Stripe anchor implied by the
 * sponsor's non-lapsed state).
 */
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
    plan: row.plan as PlanName,
    planValidUntil: row.planValidUntil,
    stripeCurrentPeriodStart: row.stripeCurrentPeriodStart
  }
}

async function getWorkspaceBilling(workspaceId: string): Promise<
  { aiEnabled: boolean, billingOwnerId: number | null } | null
> {
  const db = useDatabase()
  const rows = await db.select({
    aiEnabled: workspaces.aiEnabled,
    billingOwnerId: workspaces.billingOwnerId
  }).from(workspaces).where(eq(workspaces.workspaceId, workspaceId)).limit(1)
  return rows[0] ?? null
}

/**
 * Resolve the billing context for an AI call.
 *
 * Precedence:
 *   1. Workspace with `aiEnabled=true`, `billingOwnerId` set, and the
 *      sponsor's plan is max/ultra + not lapsed → bill the workspace
 *      at the sponsor's virtual key (sponsor's $ budget).
 *   2. Otherwise → bill the caller at their own virtual key. Lapsed
 *      paid users collapse to Free caps + Free's $1.00 budget.
 *
 * Lazy virtual-key creation: if either the caller or the (+) sponsor
 * doesn't have a LiteLLM key yet, `ensureUserKey` creates one inline.
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
  const callerActive = planActive(caller.plan, caller.planValidUntil, now)
  // A lapsed paid user reverts to Free caps until the plan-lapse
  // sweep catches up. Prevents a Pro user whose card just failed
  // from still getting Pro quota.
  const effectiveCallerPlan: PlanName = callerActive ? caller.plan : 'free'

  // (+) path: kicks in only when every precondition aligns.
  if (workspaceId) {
    const ws = await getWorkspaceBilling(workspaceId)
    if (ws && ws.aiEnabled && ws.billingOwnerId !== null) {
      const sponsor = await getUserPlan(ws.billingOwnerId)
      if (sponsor
        && supportsTeamBilling(sponsor.plan)
        && planActive(sponsor.plan, sponsor.planValidUntil, now)) {
        // Period follows the SPONSOR's cycle — every member of a
        // (+) workspace shares the sponsor's virtual key, so the
        // period window the UI displays should be theirs too.
        const sponsorPeriodStart = effectivePeriodStart({
          plan: sponsor.plan,
          stripeCurrentPeriodStart: sponsor.stripeCurrentPeriodStart,
          planValidUntil: sponsor.planValidUntil,
          now
        })
        const sponsorPeriodEnd = effectivePeriodEnd({
          plan: sponsor.plan,
          stripeCurrentPeriodStart: sponsor.stripeCurrentPeriodStart,
          planValidUntil: sponsor.planValidUntil,
          now
        })
        const sponsorKey = await ensureUserKey(ws.billingOwnerId, sponsor.plan)
        return {
          plan: sponsor.plan,
          attributedTo: `workspace:${workspaceId}` as const,
          periodStart: sponsorPeriodStart,
          periodEnd: sponsorPeriodEnd,
          virtualKey: sponsorKey.token,
          attribution: 'workspace',
          billingUserId: ws.billingOwnerId
        }
      }
      // Fall through to self-bill. Safety net: a lapsed sponsor or
      // ineligible plan (pro toggled (+) somehow) doesn't burn a
      // stale key — the caller pays from their own budget instead.
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
