import { and, asc, eq, gt, lte, sql } from 'drizzle-orm'
import { aiCreditGrants, aiCreditSettlements } from '../db/schema'
import { useDatabase } from '../utils/platform/database'

// AI credit top-ups (WP4): grants + monthly settlements. Orchestration
// (budgets, Stripe) lives in `server/utils/billing/aiCredits.ts`.

export type CreditSubjectType = 'user' | 'workspace'

export interface CreditSubject {
  type: CreditSubjectType
  id: string
}

export interface CreditGrantRow {
  id: number
  subjectType: CreditSubjectType
  subjectId: string
  pack: string
  amountUsd: number
  remainingUsd: number
  refundedUsd: number
  amountPaid: number
  currency: 'eur' | 'chf'
  stripePaymentIntentId: string
  stripeCheckoutSessionId: string | null
  expiresAt: Date
  createdAt: Date
}

type Db = ReturnType<typeof useDatabase>
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
type DbOrTx = Db | Tx

function subjectWhere(subject: CreditSubject) {
  return and(eq(aiCreditGrants.subjectType, subject.type), eq(aiCreditGrants.subjectId, subject.id))
}

/** Record a paid top-up. Returns false when the payment was already recorded. */
export async function insertCreditGrant(input: {
  subject: CreditSubject
  pack: string
  amountUsd: number
  amountPaid: number
  currency: 'eur' | 'chf'
  stripePaymentIntentId: string
  stripeCheckoutSessionId: string | null
  expiresAt: Date
}, db: DbOrTx = useDatabase()): Promise<boolean> {
  const rows = await db.insert(aiCreditGrants).values({
    subjectType: input.subject.type,
    subjectId: input.subject.id,
    pack: input.pack,
    amountUsd: input.amountUsd,
    remainingUsd: input.amountUsd,
    amountPaid: input.amountPaid,
    currency: input.currency,
    stripePaymentIntentId: input.stripePaymentIntentId,
    stripeCheckoutSessionId: input.stripeCheckoutSessionId,
    expiresAt: input.expiresAt
  }).onConflictDoNothing({ target: aiCreditGrants.stripePaymentIntentId }).returning({ id: aiCreditGrants.id })
  return rows.length > 0
}

/** Unexpired grants with something left, soonest-expiring first (the order credits are used). */
export async function listUsableGrants(subject: CreditSubject, now: Date = new Date(), db: DbOrTx = useDatabase()): Promise<CreditGrantRow[]> {
  return db.select().from(aiCreditGrants)
    .where(and(subjectWhere(subject), gt(aiCreditGrants.expiresAt, now), gt(aiCreditGrants.remainingUsd, 0)))
    .orderBy(asc(aiCreditGrants.expiresAt), asc(aiCreditGrants.id)) as Promise<CreditGrantRow[]>
}

/** Every grant of a subject, newest first (billing UI, data export). */
export async function listGrants(subject: CreditSubject, db: DbOrTx = useDatabase()): Promise<CreditGrantRow[]> {
  return db.select().from(aiCreditGrants)
    .where(subjectWhere(subject))
    .orderBy(sql`${aiCreditGrants.createdAt} desc`) as Promise<CreditGrantRow[]>
}

/** Credits still usable, USD. */
export async function sumUsableCredits(subject: CreditSubject, now: Date = new Date(), db: DbOrTx = useDatabase()): Promise<number> {
  const row = (await db.select({ total: sql<number>`coalesce(sum(${aiCreditGrants.remainingUsd}), 0)::float8` })
    .from(aiCreditGrants)
    .where(and(subjectWhere(subject), gt(aiCreditGrants.expiresAt, now), gt(aiCreditGrants.remainingUsd, 0))))[0]
  return Number(row?.total ?? 0)
}

/** Subjects that have (or had this month) usable credits — the settlement's work list. */
export async function listSubjectsWithCredits(since: Date, db: DbOrTx = useDatabase()): Promise<CreditSubject[]> {
  const rows = await db.selectDistinct({ type: aiCreditGrants.subjectType, id: aiCreditGrants.subjectId })
    .from(aiCreditGrants)
    .where(gt(aiCreditGrants.expiresAt, since))
  return rows.map(r => ({ type: r.type, id: r.id }))
}

/** Credits already taken from this subject's grants in a month. */
export async function getSettledUsd(subject: CreditSubject, period: string, db: DbOrTx = useDatabase()): Promise<number> {
  const row = (await db.select({ consumed: aiCreditSettlements.consumedUsd })
    .from(aiCreditSettlements)
    .where(and(
      eq(aiCreditSettlements.subjectType, subject.type),
      eq(aiCreditSettlements.subjectId, subject.id),
      eq(aiCreditSettlements.period, period)
    )).limit(1))[0]
  return row?.consumed ?? 0
}

/**
 * Record the subject's plan budget for an OPEN month and return the
 * highest one recorded for it (a plan that ended mid-month still covered
 * the spend made while it ran). Upsert; never lowers the stored value.
 */
export async function recordPeriodPlanBudget(subject: CreditSubject, period: string, planBudgetUsd: number, db: DbOrTx = useDatabase()): Promise<number> {
  const budget = roundUsd(Math.max(0, planBudgetUsd))
  const rows = await db.insert(aiCreditSettlements)
    .values({ subjectType: subject.type, subjectId: subject.id, period, planBudgetUsd: budget })
    .onConflictDoUpdate({
      target: [aiCreditSettlements.subjectType, aiCreditSettlements.subjectId, aiCreditSettlements.period],
      set: { planBudgetUsd: sql`greatest(coalesce(${aiCreditSettlements.planBudgetUsd}, 0), ${budget})`, updatedAt: new Date() }
    })
    .returning({ planBudgetUsd: aiCreditSettlements.planBudgetUsd })
  return rows[0]?.planBudgetUsd ?? budget
}

/** The plan budget recorded for a month, or null when no settlement ran while it was open. */
export async function getPeriodPlanBudget(subject: CreditSubject, period: string, db: DbOrTx = useDatabase()): Promise<number | null> {
  const row = (await db.select({ planBudgetUsd: aiCreditSettlements.planBudgetUsd })
    .from(aiCreditSettlements)
    .where(and(
      eq(aiCreditSettlements.subjectType, subject.type),
      eq(aiCreditSettlements.subjectId, subject.id),
      eq(aiCreditSettlements.period, period)
    )).limit(1))[0]
  return row?.planBudgetUsd ?? null
}

/** Advisory-lock key serialising every change to one subject's grants. */
function creditLockKey(subject: CreditSubject): string {
  return `ai-credits:${subject.type}:${subject.id}`
}

/**
 * Take `amountUsd` from the subject's usable grants (soonest-expiring
 * first) and add what was actually taken to the month's settlement, in
 * one transaction with a per-subject advisory lock. Returns the USD
 * taken (less than asked when the credits run out).
 */
export async function consumeCredits(subject: CreditSubject, period: string, amountUsd: number, now: Date = new Date()): Promise<number> {
  if (!(amountUsd > 0)) return 0
  return useDatabase().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${creditLockKey(subject)}))`)
    let left = amountUsd
    for (const grant of await listUsableGrants(subject, now, tx)) {
      if (left <= 0) break
      const take = Math.min(left, grant.remainingUsd)
      await tx.update(aiCreditGrants).set({ remainingUsd: roundUsd(grant.remainingUsd - take) }).where(eq(aiCreditGrants.id, grant.id))
      left -= take
    }
    const taken = roundUsd(amountUsd - Math.max(0, left))
    if (taken > 0) {
      await tx.insert(aiCreditSettlements).values({ subjectType: subject.type, subjectId: subject.id, period, consumedUsd: taken })
        .onConflictDoUpdate({
          target: [aiCreditSettlements.subjectType, aiCreditSettlements.subjectId, aiCreditSettlements.period],
          set: { consumedUsd: sql`${aiCreditSettlements.consumedUsd} + ${taken}`, updatedAt: new Date() }
        })
    }
    return taken
  })
}

/**
 * Settle a month to an absolute figure: make the month's settlement
 * equal `targetConsumedUsd` by taking only the difference. Idempotent.
 */
export async function settleMonth(subject: CreditSubject, period: string, targetConsumedUsd: number, now: Date = new Date()): Promise<number> {
  const already = await getSettledUsd(subject, period)
  const delta = roundUsd(targetConsumedUsd - already)
  return delta > 0 ? consumeCredits(subject, period, delta, now) : 0
}

/**
 * A (partial) refund of a top-up: the refunded share of the grant's
 * credit is removed (what's left of it first; credits already used stay
 * used). Returns the subject, or null for an unknown payment.
 */
export async function refundCreditGrant(paymentIntentId: string, refundedFraction: number, db: DbOrTx = useDatabase()): Promise<CreditSubject | null> {
  const found = (await db.select({ subjectType: aiCreditGrants.subjectType, subjectId: aiCreditGrants.subjectId })
    .from(aiCreditGrants).where(eq(aiCreditGrants.stripePaymentIntentId, paymentIntentId)).limit(1))[0]
  if (!found) return null
  // Same per-subject lock as `consumeCredits` (held until the caller's
  // transaction ends), and the grant re-read under it: otherwise a
  // settlement taking from this grant at the same moment and this refund
  // each write `remaining_usd` from a stale read, and one write is lost.
  await db.execute(sql`select pg_advisory_xact_lock(hashtext(${creditLockKey({ type: found.subjectType, id: found.subjectId })}))`)
  const grant = (await db.select().from(aiCreditGrants).where(eq(aiCreditGrants.stripePaymentIntentId, paymentIntentId)).limit(1))[0] as CreditGrantRow | undefined
  if (!grant) return null
  const fraction = Math.min(1, Math.max(0, refundedFraction))
  const targetRefunded = roundUsd(grant.amountUsd * fraction)
  const newlyRefunded = Math.max(0, targetRefunded - grant.refundedUsd)
  await db.update(aiCreditGrants).set({
    refundedUsd: targetRefunded,
    remainingUsd: roundUsd(Math.max(0, grant.remainingUsd - newlyRefunded))
  }).where(eq(aiCreditGrants.id, grant.id))
  return { type: grant.subjectType, id: grant.subjectId }
}

/** Expired grants that still show a remainder → 0. Returns their subjects. */
export async function expireGrants(now: Date = new Date(), db: DbOrTx = useDatabase()): Promise<CreditSubject[]> {
  const rows = await db.update(aiCreditGrants).set({ remainingUsd: 0 })
    .where(and(lte(aiCreditGrants.expiresAt, now), gt(aiCreditGrants.remainingUsd, 0)))
    .returning({ type: aiCreditGrants.subjectType, id: aiCreditGrants.subjectId })
  return rows.map(r => ({ type: r.type, id: r.id }))
}

/** Delete a subject's grants + settlements (account / workspace deleted). */
export async function deleteCreditsForSubject(subject: CreditSubject, db: DbOrTx = useDatabase()): Promise<number> {
  const rows = await db.delete(aiCreditGrants).where(subjectWhere(subject)).returning({ id: aiCreditGrants.id })
  await db.delete(aiCreditSettlements).where(and(eq(aiCreditSettlements.subjectType, subject.type), eq(aiCreditSettlements.subjectId, subject.id)))
  return rows.length
}

function roundUsd(value: number): number {
  return Math.round(value * 10_000) / 10_000
}
