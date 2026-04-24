import { eq, and, sql } from 'drizzle-orm'
import { users, workspaces, aiUsagePeriod } from '../db/schema'
import { useDatabase } from './database'
import { TIERS, type PlanName } from '~~/shared/config/tiers'

/**
 * Billing context resolution.
 *
 * Every AI call (phase 3+) needs to answer two questions:
 *   1. WHICH plan's caps apply (for interaction accounting + tier limits)?
 *   2. WHO gets charged (the caller, or a `(+)` workspace's billing owner)?
 *
 * `resolveBillingContext` is the single source of truth. Every enforcement
 * site calls this once at session-open and threads the result through.
 *
 * Phase 2 only READS; nothing in this file mutates the DB.
 */

/**
 * Identifier for the billing target. Shape is `user:{id}` or
 * `workspace:{id}` — the prefix tells phase-3 code which kind of target
 * a period row refers to without a separate column. This is also the
 * primary key of `ai_usage_period.attributed_to`.
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
   * current calendar month UTC. See `effectivePeriodStart`.
   */
  periodStart: Date
  /**
   * End of the current billing period. Paid users: Stripe's
   * `current_period_end`. Free users: first of the next calendar
   * month UTC (= derived from periodStart + 1 month).
   */
  periodEnd: Date
  /** How many interactions remain in this period. Clamped to 0 at cap. */
  interactionsRemaining: number
  /**
   * For diagnostics: did we redirect via `(+)` or bill the caller
   * directly? `'workspace'` = `(+)` active and owner's plan covers it;
   * `'user'` = default self-bill.
   */
  attribution: 'user' | 'workspace'
}

/**
 * First day of the current calendar month, UTC, at 00:00:00.000.
 * Free users anchor their billing period here; paid users instead use
 * `effectivePeriodStart` which reads their Stripe anniversary.
 */
export function currentPeriodStart(now: Date = new Date()): Date {
  // Construct explicitly in UTC. `new Date(Date.UTC(y, m, 1))` would
  // work too; this form is symmetric with the way Postgres stores the
  // column (TIMESTAMP WITH TIME ZONE, mode: 'date').
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0))
}

/** First of the next calendar month, UTC. Used by `effectivePeriodEnd` for free users. */
function nextCalendarMonthStart(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0))
}

/**
 * Resolve the billing-period start for a given user. Model C (see
 * AGENTS.md §15 — phase 7):
 *
 *   - Free users → calendar-month UTC anchor. One shared cadence for
 *     everyone who isn't paying, no per-user timestamps to track.
 *   - Paid users with `stripeCurrentPeriodStart` set → that timestamp.
 *     Matches Stripe's invoice cycle so quota resets on the renewal
 *     date, which is what users expect.
 *   - Paid users WITHOUT `stripeCurrentPeriodStart` → calendar fallback.
 *     Happens for fixtures / pre-Stripe admin-promoted users. Gives
 *     them SOME period anchor without breaking.
 *   - Lapsed paid users (planValidUntil < now) → calendar fallback,
 *     because the resolver defensively treats them as Free at the
 *     call site (a lapsed user shouldn't still have their stripe
 *     anchor preserved — they effectively switched back to free).
 */
export function effectivePeriodStart(args: {
  plan: PlanName
  stripeCurrentPeriodStart: Date | null
  planValidUntil: Date | null
  now?: Date
}): Date {
  const now = args.now ?? new Date()
  const lapsed = args.plan !== 'free'
    && args.planValidUntil !== null
    && args.planValidUntil.getTime() <= now.getTime()
  if (args.plan === 'free' || lapsed) return currentPeriodStart(now)
  if (args.stripeCurrentPeriodStart) return args.stripeCurrentPeriodStart
  return currentPeriodStart(now)
}

/**
 * End of the billing period. Free: first of next calendar month UTC.
 * Paid with Stripe data: `planValidUntil` (aliased to
 * `stripe.current_period_end`). Paid without Stripe data: calendar
 * fallback, matching effectivePeriodStart's same-fallback logic.
 */
export function effectivePeriodEnd(args: {
  plan: PlanName
  stripeCurrentPeriodStart: Date | null
  planValidUntil: Date | null
  now?: Date
}): Date {
  const now = args.now ?? new Date()
  const lapsed = args.plan !== 'free'
    && args.planValidUntil !== null
    && args.planValidUntil.getTime() <= now.getTime()
  if (args.plan === 'free' || lapsed) return nextCalendarMonthStart(now)
  if (args.stripeCurrentPeriodStart && args.planValidUntil) return args.planValidUntil
  return nextCalendarMonthStart(now)
}

/**
 * Whether a plan is a paid plan that supports `(+)` workspace billing.
 * Only max + ultra can be `billing_owner` of a `(+)` workspace — pro
 * users' subscription is personal-only. Free is never a billing
 * attribution target (their cap is 100/mo which would be instantly
 * drained by one coworker).
 */
function supportsTeamBilling(plan: PlanName): boolean {
  return plan === 'max' || plan === 'ultra'
}

/**
 * True if a user's paid-plan entitlements are still active. `plan_valid_until`
 * is NULL for Free (never lapses) and set to current_period_end for paid tiers.
 * A `null` expiry on a paid plan is treated as "never lapses" (e.g. test
 * fixtures); in production every non-free row gets a real timestamp.
 */
function planActive(plan: PlanName, planValidUntil: Date | null, now: Date): boolean {
  if (plan === 'free') return true
  if (planValidUntil === null) return true
  return planValidUntil.getTime() > now.getTime()
}

/**
 * Look up a user's plan row. Returns a safe fallback (free, no expiry)
 * if the user doesn't exist — phase 2 is non-enforcing so we'd rather
 * log "would-charge user:?" than throw and break the AI flow. Phase 3
 * hardens this to throw; the fallback goes away.
 */
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
  if (rows.length === 0) return null
  return {
    plan: rows[0].plan as PlanName,
    planValidUntil: rows[0].planValidUntil,
    stripeCurrentPeriodStart: rows[0].stripeCurrentPeriodStart
  }
}

/**
 * Look up the `(+)` state + billing owner for a workspace. Returns null
 * if the workspace doesn't exist or `aiEnabled` is false — both cases
 * mean "no team billing, bill the caller directly".
 */
async function getWorkspaceBilling(workspaceId: string): Promise<
  { aiEnabled: boolean, billingOwnerId: number | null } | null
> {
  const db = useDatabase()
  const rows = await db.select({
    aiEnabled: workspaces.aiEnabled,
    billingOwnerId: workspaces.billingOwnerId
  }).from(workspaces).where(eq(workspaces.workspaceId, workspaceId)).limit(1)
  if (rows.length === 0) return null
  return rows[0]
}

/**
 * Interactions remaining in the current period for a given attribution
 * target. Reads one row from `ai_usage_period`; returns `cap` if no row
 * exists yet (a user who hasn't used AI this month is at 0 consumed).
 * Always clamped at >= 0 so "over-cap by 3" doesn't surface as a
 * negative remaining.
 */
/**
 * Thrown by `chargeInteractions` when a charge would push usage past
 * the plan cap. The error carries the target + the attempted delta so
 * the caller can decide how to surface it (402 at session open, an
 * `insert_text` upgrade breadcrumb mid-loop, a 402 on the transcribe
 * endpoint, etc.).
 *
 * Atomicity: the DB increment is rolled back before we throw, so a
 * thrown BudgetExhausted means "no interactions were spent." Never
 * let a charge succeed in the DB and then throw; that would silently
 * drain the pool past its cap.
 */
/**
 * Convert audio duration to interactions. Rate: 5 interactions per
 * minute (per AGENTS.md §15), implemented as 1 interaction per 12
 * seconds with ceil rounding — so a 7-second clip costs 1, a 13-second
 * clip costs 2, and a 60-second clip costs exactly 5. Finer granularity
 * than "round up to nearest minute" so short clips don't incur a full
 * minute's worth of charge.
 */
export function interactionsForAudioMs(ms: number): number {
  if (ms <= 0) return 0
  return Math.ceil(ms / 12_000)
}

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
 * Test-mode bypass. Same semantics as the rate-limit helpers:
 * `TEST_MODE=1` in integration suites and dev fixtures skips the
 * charge entirely so tests don't need to reason about quota. Production
 * MUST never set this.
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
 * If the returned counter would exceed the plan cap, the row is rolled
 * back (sub-transaction) and we throw `BudgetExhausted`. The cap check
 * is POST-increment so two concurrent callers see consistent ordering:
 * the atomic increment is the serialization point, not a read-then-write.
 *
 * Concurrency: Postgres handles this safely — `ON CONFLICT DO UPDATE`
 * acquires a row lock, so simultaneous `chargeInteractions(user:1, 1)`
 * from two connections produce a sum that accounts for both. The rare
 * "both pushed us past the cap by 1" overshoot is bounded by the
 * number of simultaneous callers × delta, which in practice is < 5
 * interactions for any realistic racing pattern.
 *
 * Test mode (`TEST_MODE=1`) skips the write entirely and returns the
 * remaining-as-full-cap. Integration tests that want to exercise the
 * BudgetExhausted path seed the period row directly via SQL.
 */
export async function chargeInteractions(opts: {
  attributedTo: AttributedTo
  plan: PlanName
  delta: number
  /**
   * REQUIRED: start of the billing period this charge lands in.
   * Callers resolve this via `effectivePeriodStart()` or pull it from
   * the `BillingContext` returned by `resolveBillingContext`. We
   * don't default to `currentPeriodStart()` anymore — that would
   * silently charge paid users to the wrong row (calendar month vs
   * Stripe anniversary) and the bug would only surface weeks later
   * when quotas renewed at the wrong time.
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

  // Wrap the INSERT in a transaction so we can ROLLBACK atomically on
  // cap-overshoot. Drizzle's tx.rollback() throws — we catch it and
  // convert to BudgetExhausted so the caller sees a clean boundary.
  //
  // `EXCLUDED.interactions_used` inside DO UPDATE is the delta that the
  // (failed) INSERT tried to set — PostgreSQL's ON CONFLICT resolution
  // exposes it as the "would-have-been-inserted" tuple.
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
      // node-postgres returns {rows: [...]}; drizzle's execute wraps that.
      const row = (rows as unknown as { rows: Array<{ interactions_used: number }> }).rows[0]
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
    // Read the actual `used` at rollback point — newUsed held the
    // would-be total, but the row on disk still shows the pre-charge
    // value. Re-read for accurate error telemetry.
    const current = await getInteractionsRemaining(attributedTo, plan, periodStart)
    throw new BudgetExhausted({
      attributedTo, plan,
      requestedDelta: delta,
      used: cap - current,
      cap
    })
  }

  // newUsed is set if we got past the rollback branch.
  const used = newUsed ?? 0
  return { used, remaining: Math.max(0, cap - used) }
}

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

  const used = rows.length === 0 ? 0 : rows[0].used
  return Math.max(0, cap - used)
}

/**
 * Resolve the billing context for an AI call.
 *
 * Rules (in order):
 *   1. No workspace context → bill the caller, plan = caller's plan.
 *   2. Workspace exists + aiEnabled + billingOwner set + billingOwner's
 *      plan supports team billing AND is not lapsed → bill the
 *      workspace, plan = billing owner's plan.
 *   3. Otherwise (aiEnabled=false, no billing owner, or owner's plan
 *      ineligible / lapsed) → bill the caller, plan = caller's plan.
 *
 * If the caller's user row is missing (unlikely — they'd have no valid
 * session), returns a safe-default context with plan='free' and
 * interactionsRemaining=0. Phase 3 will throw; phase 2 logs-only.
 */
export async function resolveBillingContext(
  userId: number,
  workspaceId: string | null | undefined
): Promise<BillingContext> {
  const now = new Date()

  const caller = await getUserPlan(userId)
  const callerPlan: PlanName = caller?.plan ?? 'free'
  const callerActive = caller ? planActive(callerPlan, caller.planValidUntil, now) : true
  // A lapsed paid user effectively reverts to Free semantics until
  // Stripe updates them. Phase 4's sweep flips the `plan` column back
  // to `'free'` on expiry; until that runs, we defensively downgrade
  // here so a lapsed Pro doesn't still get Pro caps.
  const effectiveCallerPlan: PlanName = callerActive ? callerPlan : 'free'

  // Try the (+) path first. Only kicks in when all FOUR preconditions
  // align: workspaceId given, workspace row exists, aiEnabled=true,
  // billingOwnerId non-null, owner's plan supports team billing, owner
  // not lapsed.
  if (workspaceId) {
    const ws = await getWorkspaceBilling(workspaceId)
    if (ws && ws.aiEnabled && ws.billingOwnerId !== null) {
      const owner = await getUserPlan(ws.billingOwnerId)
      if (owner && supportsTeamBilling(owner.plan as PlanName)
          && planActive(owner.plan as PlanName, owner.planValidUntil, now)) {
        // The period follows the SPONSOR's Stripe cycle, not the
        // caller's. That way every member of a (+) workspace shares
        // one counter keyed on (workspace:X, sponsor's periodStart),
        // and the pool resets when the sponsor's subscription renews.
        const sponsorPlan = owner.plan as PlanName
        const sponsorPeriodStart = effectivePeriodStart({
          plan: sponsorPlan,
          stripeCurrentPeriodStart: owner.stripeCurrentPeriodStart,
          planValidUntil: owner.planValidUntil,
          now
        })
        const sponsorPeriodEnd = effectivePeriodEnd({
          plan: sponsorPlan,
          stripeCurrentPeriodStart: owner.stripeCurrentPeriodStart,
          planValidUntil: owner.planValidUntil,
          now
        })
        const attributedTo = `workspace:${workspaceId}` as const
        const remaining = await getInteractionsRemaining(
          attributedTo, sponsorPlan, sponsorPeriodStart
        )
        return {
          plan: sponsorPlan,
          attributedTo,
          periodStart: sponsorPeriodStart,
          periodEnd: sponsorPeriodEnd,
          interactionsRemaining: remaining,
          attribution: 'workspace'
        }
      }
      // Falls through to self-bill. This is the safety net: if a Max
      // user lapses and the workspace is still aiEnabled=true, we
      // DON'T burn their stale pool — we charge the caller. Phase 4
      // sweep tidies up by flipping aiEnabled=false.
    }
  }

  // Self-bill path. Period anchored per Model C:
  //   - Free (including defensively-downgraded lapsed users) →
  //     calendar-month UTC.
  //   - Paid + active → Stripe's current_period_start.
  const selfPeriodStart = effectivePeriodStart({
    plan: effectiveCallerPlan,
    stripeCurrentPeriodStart: caller?.stripeCurrentPeriodStart ?? null,
    planValidUntil: caller?.planValidUntil ?? null,
    now
  })
  const selfPeriodEnd = effectivePeriodEnd({
    plan: effectiveCallerPlan,
    stripeCurrentPeriodStart: caller?.stripeCurrentPeriodStart ?? null,
    planValidUntil: caller?.planValidUntil ?? null,
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
