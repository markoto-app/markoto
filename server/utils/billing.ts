import { eq, and, sql } from 'drizzle-orm'
import { users, workspaces, aiUsagePeriod } from '../db/schema'
import { useDatabase } from './database'
import { TIERS, type PlanName } from '~~/shared/config/tiers'

/**
 * Billing context resolution. Every AI call site calls
 * `resolveBillingContext` once and threads the result through:
 *
 *   1. WHICH plan's caps apply (interaction accounting + tier limits)?
 *   2. WHO gets charged — the caller, or a `(+)` workspace's sponsor?
 *
 * All downstream charge + quota logic trusts the returned context.
 */

/**
 * Identifier for the billing target. `user:{id}` or `workspace:{id}`
 * — the prefix tells period/charge code which kind of target a row
 * refers to without a separate column. It's also the primary-key
 * component of `ai_usage_period.attributed_to`.
 */
export type AttributedTo = `user:${number}` | `workspace:${string}`

export interface BillingContext {
  /** The effective plan. Determines caps. */
  plan: PlanName
  /** Who gets charged — `user:{id}` or `workspace:{wsId}`. */
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
   * month UTC.
   */
  periodEnd: Date
  /** How many interactions remain in this period. Clamped to 0 at cap. */
  interactionsRemaining: number
  /**
   * For diagnostics: `'workspace'` = `(+)` active and sponsor covers
   * the caller; `'user'` = self-bill.
   */
  attribution: 'user' | 'workspace'
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
 * Resolve the billing-period start for a user. Model C (AGENTS.md §15):
 *
 *   - Free (or defensively-downgraded lapsed) → calendar-month UTC.
 *   - Active paid user with Stripe anchor set → that anchor.
 *
 * Note: a paid user with no Stripe anchor or a lapsed `planValidUntil`
 * is treated as Free — the resolver collapses them into the calendar
 * branch. This matches `effectivePeriodEnd` + the active/lapsed check
 * in `resolveBillingContext` so start/end always agree on one anchor.
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
 * Any failure of those → fall back to the calendar anchor. This is
 * the single place that check lives — both period-start and
 * period-end helpers call it so they never disagree.
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
 * Convert audio duration to interactions. Rate: 5 interactions per
 * minute (AGENTS.md §15), implemented as 1 interaction per 12 seconds
 * with ceil rounding — so a 7-second clip costs 1, a 13-second clip
 * costs 2, and a 60-second clip costs exactly 5.
 */
export function interactionsForAudioMs(ms: number): number {
  if (ms <= 0) return 0
  return Math.ceil(ms / 12_000)
}

/**
 * Thrown by `chargeInteractions` when a charge would push usage past
 * the plan cap. Carries the target + attempted delta so the caller
 * can decide how to surface it (402 at session open, `insert_text`
 * upgrade breadcrumb mid-loop, 402 at the transcribe endpoint, …).
 *
 * Atomicity: the DB increment is rolled back before we throw, so a
 * BudgetExhausted always means "no interactions were spent."
 */
export class BudgetExhausted extends Error {
  readonly attributedTo: AttributedTo
  readonly plan: PlanName
  readonly requestedDelta: number
  readonly used: number
  readonly cap: number
  constructor(opts: {
    attributedTo: AttributedTo
    plan: PlanName
    requestedDelta: number
    used: number
    cap: number
  }) {
    super(`Budget exhausted for ${opts.attributedTo} (plan=${opts.plan}, used=${opts.used}/${opts.cap}, wanted +${opts.requestedDelta}).`)
    this.name = 'BudgetExhausted'
    this.attributedTo = opts.attributedTo
    this.plan = opts.plan
    this.requestedDelta = opts.requestedDelta
    this.used = opts.used
    this.cap = opts.cap
  }
}

/**
 * `TEST_MODE=1` in integration suites skips the charge write so tests
 * don't need to reason about quota. Production MUST never set this.
 */
function isTestMode(): boolean {
  return process.env.TEST_MODE === '1'
}

/**
 * Atomic interaction charge. Single SQL round-trip:
 *   INSERT ... ON CONFLICT (attributed_to, period_start)
 *   DO UPDATE SET interactions_used = used + delta, updated_at = now()
 *   RETURNING interactions_used
 *
 * Post-increment cap check: if the returned counter exceeds the plan
 * cap, the transaction rolls back and we throw BudgetExhausted. The
 * atomic increment IS the serialization point — two concurrent
 * callers produce a sum that accounts for both (Postgres row lock on
 * `ON CONFLICT DO UPDATE`).
 *
 * Test mode returns `{used: 0, remaining: cap}` without touching the
 * DB. Integration tests that need BudgetExhausted seed the period
 * row directly via SQL.
 */
export async function chargeInteractions(opts: {
  attributedTo: AttributedTo
  plan: PlanName
  delta: number
  /**
   * Start of the billing period this charge lands in. Callers pull
   * it from the `BillingContext` returned by `resolveBillingContext`
   * (paid users' Stripe anniversary, free users' calendar month).
   */
  periodStart: Date
  reason?: string
}): Promise<{ used: number, remaining: number }> {
  const { attributedTo, plan, delta, periodStart } = opts
  if (delta <= 0) {
    throw new Error(`[billing] chargeInteractions: delta must be positive, got ${delta}`)
  }
  if (isTestMode()) {
    const cap = TIERS[plan].interactionsPerMonth
    return { used: 0, remaining: cap }
  }

  const db = useDatabase()
  const cap = TIERS[plan].interactionsPerMonth

  let newUsed: number | null = null
  let wasRollback = false
  try {
    await db.transaction(async (tx) => {
      const rows = await tx.execute(sql`
        INSERT INTO ${aiUsagePeriod} (attributed_to, period_start, interactions_used)
        VALUES (${attributedTo}, ${periodStart}, ${delta})
        ON CONFLICT (attributed_to, period_start)
        DO UPDATE SET interactions_used = ${aiUsagePeriod.interactionsUsed} + EXCLUDED.interactions_used,
                      updated_at = now()
        RETURNING interactions_used
      `)
      const row = (rows as unknown as { rows: Array<{ interactions_used: number }> }).rows[0]
      if (!row) throw new Error('billing upsert returned no row')
      newUsed = Number(row.interactions_used)
      if (newUsed > cap) {
        wasRollback = true
        tx.rollback()
      }
    })
  } catch (e) {
    // drizzle's rollback throws a sentinel; re-throw anything else.
    const msg = e instanceof Error ? e.message : ''
    if (!wasRollback && !/rollback/i.test(msg)) {
      throw e
    }
  }

  if (wasRollback) {
    // Re-read the row-on-disk's `used` value — `newUsed` held the
    // would-be total, but the row preserved its pre-charge value
    // when the tx rolled back.
    const current = await getInteractionsRemaining(attributedTo, plan, periodStart)
    throw new BudgetExhausted({
      attributedTo, plan,
      requestedDelta: delta,
      used: cap - current,
      cap
    })
  }

  const used = newUsed ?? 0
  return { used, remaining: Math.max(0, cap - used) }
}

/**
 * Interactions remaining in the current period for a given target.
 * Returns `cap` if no row exists yet. Always clamped at >= 0.
 */
export async function getInteractionsRemaining(
  attributedTo: AttributedTo,
  plan: PlanName,
  periodStart: Date = currentPeriodStart()
): Promise<number> {
  const db = useDatabase()
  const cap = TIERS[plan].interactionsPerMonth

  const rows = await db.select({ used: aiUsagePeriod.interactionsUsed })
    .from(aiUsagePeriod)
    .where(and(
      eq(aiUsagePeriod.attributedTo, attributedTo),
      eq(aiUsagePeriod.periodStart, periodStart)
    ))
    .limit(1)

  const used = rows[0]?.used ?? 0
  return Math.max(0, cap - used)
}

/**
 * Resolve the billing context for an AI call.
 *
 * Precedence:
 *   1. Workspace with `aiEnabled=true`, `billingOwnerId` set, and the
 *      sponsor's plan is max/ultra + not lapsed → bill the workspace
 *      at the sponsor's plan + sponsor's Stripe cycle.
 *   2. Otherwise → bill the caller at their own plan + their own
 *      Stripe cycle. Lapsed paid users collapse to Free caps.
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
        // (+) workspace shares one counter row keyed on the
        // sponsor's period, resetting when their invoice renews.
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
        const attributedTo = `workspace:${workspaceId}` as const
        const remaining = await getInteractionsRemaining(
          attributedTo, sponsor.plan, sponsorPeriodStart
        )
        return {
          plan: sponsor.plan,
          attributedTo,
          periodStart: sponsorPeriodStart,
          periodEnd: sponsorPeriodEnd,
          interactionsRemaining: remaining,
          attribution: 'workspace'
        }
      }
      // Fall through to self-bill. Safety net: a lapsed sponsor or
      // ineligible plan (pro toggled (+) somehow) doesn't burn a
      // stale pool — the caller pays from their own quota instead.
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
  const attributedTo = `user:${userId}` as const
  const remaining = await getInteractionsRemaining(
    attributedTo, effectiveCallerPlan, selfPeriodStart
  )
  return {
    plan: effectiveCallerPlan,
    attributedTo,
    periodStart: selfPeriodStart,
    periodEnd: selfPeriodEnd,
    interactionsRemaining: remaining,
    attribution: 'user'
  }
}
