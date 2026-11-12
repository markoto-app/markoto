import { and, eq, isNull, lt, or } from 'drizzle-orm'
import { users } from '../db/schema'
import { useDatabase } from '../utils/platform/database'
import type { PersonalPlanName } from '~~/shared/config/tiers'
import type { Currency } from '~~/shared/config/pricing'

// The personal plan + Stripe columns of `users`. Written by the Stripe
// webhook (inside its per-event transaction: pass its `db`) and read by the
// Pro checkout.

type Db = ReturnType<typeof useDatabase>
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
type DbOrTx = Db | Tx

export interface UserBillingUpdate {
  where: { stripeCustomerId: string } | { id: number }
  set: Partial<{
    plan: PersonalPlanName
    planValidUntil: Date | null
    stripeCurrentPeriodStart: Date | null
    stripeCustomerId: string | null
    stripeSubscriptionId: string | null
    billingCurrency: Currency | null
  }>
}

/**
 * One-shot user update by customer id OR by internal user id. Returns
 * the number of rows matched (0 when the customer id doesn't map to a
 * user — logged but not fatal).
 */
export async function updateUserBilling(opts: UserBillingUpdate, db?: DbOrTx): Promise<number> {
  const handle = db ?? useDatabase()
  const where = 'id' in opts.where
    ? eq(users.id, opts.where.id)
    : eq(users.stripeCustomerId, opts.where.stripeCustomerId)
  const result = await handle.update(users).set(opts.set).where(where).returning({ id: users.id })
  return result.length
}

/** Resolve `users.id` from a Stripe customer id (null if none). */
export async function findUserIdByStripeCustomer(customerId: string, db?: DbOrTx): Promise<number | null> {
  const conn = db ?? useDatabase()
  const rows = await conn.select({ id: users.id })
    .from(users)
    .where(eq(users.stripeCustomerId, customerId))
    .limit(1)
  return rows[0]?.id ?? null
}

/**
 * Apply a subscription's state to the user whose CURRENT subscription it is
 * (customer + subscription id both match). Returns the rows matched.
 */
export async function applyUserSubscriptionState(db: DbOrTx, customerId: string, subscriptionId: string, set: UserBillingUpdate['set']): Promise<number> {
  return (await db.update(users).set(set)
    .where(and(eq(users.stripeCustomerId, customerId), eq(users.stripeSubscriptionId, subscriptionId)))
    .returning({ id: users.id })).length
}

/** Move the user's period anchors forward to `period` (never back). Returns the rows matched. */
export async function advanceUserBillingPeriod(db: DbOrTx, customerId: string, subscriptionId: string, period: { start: Date, end: Date }): Promise<number> {
  const result = await db.update(users)
    .set({ stripeCurrentPeriodStart: period.start, planValidUntil: period.end })
    .where(and(
      eq(users.stripeCustomerId, customerId),
      eq(users.stripeSubscriptionId, subscriptionId),
      or(isNull(users.planValidUntil), lt(users.planValidUntil, period.end))
    ))
    .returning({ id: users.id })
  return result.length
}

/** A personal buyer's first Stripe customer id (and its currency); an existing one is kept. */
export async function stampFirstStripeCustomer(db: DbOrTx, userId: number, customerId: string, currency: Currency): Promise<void> {
  await db.update(users)
    .set({ stripeCustomerId: customerId, billingCurrency: currency })
    .where(and(eq(users.id, userId), isNull(users.stripeCustomerId)))
}

/** What the Pro checkout needs of the buyer: email, Stripe customer + subscription, locked currency. */
export async function getUserCheckoutBilling(userId: number): Promise<{
  email: string | null
  stripeCustomerId: string | null
  stripeSubscriptionId: string | null
  billingCurrency: Currency | null
} | null> {
  const db = useDatabase()
  const rows = await db.select({
    email: users.email,
    stripeCustomerId: users.stripeCustomerId,
    stripeSubscriptionId: users.stripeSubscriptionId,
    billingCurrency: users.billingCurrency
  }).from(users).where(eq(users.id, userId)).limit(1)
  return rows[0] ?? null
}
