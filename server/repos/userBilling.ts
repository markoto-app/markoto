import { and, eq, isNull, lt, or } from 'drizzle-orm'
import { users } from '../db/schema'
import { executor, useDatabase, type TxHandle } from '../db/client'
import type { PersonalPlanName } from '~~/shared/config/tiers'
import type { Currency } from '~~/shared/config/pricing'
import type { SystemActor, UserScope } from './proofs'

// The personal plan + Stripe columns of `users`. Written by the Stripe
// webhook (inside its per-event transaction: pass its `db`) and read by the
// Pro checkout.

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
export async function updateUserBilling(_by: SystemActor, opts: UserBillingUpdate, tx?: TxHandle): Promise<number> {
  const db = executor(tx)
  const where = 'id' in opts.where
    ? eq(users.id, opts.where.id)
    : eq(users.stripeCustomerId, opts.where.stripeCustomerId)
  const result = await db.update(users).set(opts.set).where(where).returning({ id: users.id })
  return result.length
}

/** Resolve `users.id` from a Stripe customer id (null if none). */
export async function findUserIdByStripeCustomer(_by: SystemActor, customerId: string, tx?: TxHandle): Promise<number | null> {
  const db = executor(tx)
  const rows = await db.select({ id: users.id })
    .from(users)
    .where(eq(users.stripeCustomerId, customerId))
    .limit(1)
  return rows[0]?.id ?? null
}

/**
 * Apply a subscription's state to the user whose CURRENT subscription it is
 * (customer + subscription id both match). Returns the rows matched.
 */
export async function applyUserSubscriptionState(_by: SystemActor, tx: TxHandle | undefined, customerId: string, subscriptionId: string, set: UserBillingUpdate['set']): Promise<number> {
  const db = executor(tx)
  return (await db.update(users).set(set)
    .where(and(eq(users.stripeCustomerId, customerId), eq(users.stripeSubscriptionId, subscriptionId)))
    .returning({ id: users.id })).length
}

/** Move the user's period anchors forward to `period` (never back). Returns the rows matched. */
export async function advanceUserBillingPeriod(_by: SystemActor, tx: TxHandle | undefined, customerId: string, subscriptionId: string, period: { start: Date, end: Date }): Promise<number> {
  const db = executor(tx)
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
export async function stampFirstStripeCustomer(_by: SystemActor, tx: TxHandle | undefined, userId: number, customerId: string, currency: Currency): Promise<void> {
  const db = executor(tx)
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

/** The Stripe customer of the user's own billing (portal). */
export async function getOwnStripeCustomerId(self: UserScope): Promise<string | null> {
  return (await useDatabase().select({ stripeCustomerId: users.stripeCustomerId }).from(users).where(eq(users.id, self.userId)).limit(1))[0]?.stripeCustomerId ?? null
}

/** What a personal credit top-up checks about the buyer. */
export async function getOwnTopupFacts(self: UserScope) {
  return (await useDatabase().select({
    email: users.email,
    plan: users.plan,
    planValidUntil: users.planValidUntil,
    stripeCustomerId: users.stripeCustomerId,
    billingCurrency: users.billingCurrency
  }).from(users).where(eq(users.id, self.userId)).limit(1))[0] ?? null
}
