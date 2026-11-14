import { and, eq, isNull, lt, lte, or } from 'drizzle-orm'
import { users } from '../db/schema'
import { executor, useDatabase, type TxHandle } from '../db/client'
import type { PersonalPlanName } from '~~/shared/config/tiers'
import type { BillingInterval, Currency } from '~~/shared/config/pricing'
import type { StripeSubscriptionStatus } from '~~/shared/contracts/stripe'
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
    billingInterval: BillingInterval | null
    planCancelAt: Date | null
    subscriptionStatus: StripeSubscriptionStatus | null
    subscriptionEventAt: Date | null
  }>
}

/**
 * The age rule (`stripeEvents/eventAge.ts`): the row's subscription state
 * is not newer than `at`. Equal times pass.
 */
function stateNotNewerThan(at: Date) {
  return or(isNull(users.subscriptionEventAt), lte(users.subscriptionEventAt, at))
}

/**
 * One-shot user update by customer id OR by internal user id. Returns
 * the number of rows matched (0 when the customer id doesn't map to a
 * user: logged but not fatal).
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
 * Apply a subscription's state as of `at` to the user whose CURRENT
 * subscription it is (customer + subscription id both match), unless the
 * row already holds newer state. Returns the rows matched.
 */
export async function applyUserSubscriptionState(_by: SystemActor, tx: TxHandle | undefined, customerId: string, subscriptionId: string, set: UserBillingUpdate['set'], at: Date): Promise<number> {
  const db = executor(tx)
  return (await db.update(users).set({ ...set, subscriptionEventAt: at })
    .where(and(eq(users.stripeCustomerId, customerId), eq(users.stripeSubscriptionId, subscriptionId), stateNotNewerThan(at)))
    .returning({ id: users.id })).length
}

/**
 * The customer's subscription ended at `at`: back to Free, the Stripe
 * anchors cleared (customer and currency stay for a later purchase).
 * Not applied when the row holds newer state (a new subscription bought
 * since). Returns the rows matched.
 */
export async function endUserSubscription(_by: SystemActor, tx: TxHandle | undefined, customerId: string, at: Date): Promise<number> {
  const db = executor(tx)
  return (await db.update(users)
    .set({
      plan: 'free',
      stripeSubscriptionId: null,
      stripeCurrentPeriodStart: null,
      planValidUntil: null,
      billingInterval: null,
      planCancelAt: null,
      subscriptionStatus: null,
      subscriptionEventAt: at
    })
    .where(and(eq(users.stripeCustomerId, customerId), stateNotNewerThan(at)))
    .returning({ id: users.id })).length
}

/**
 * Move the user's period anchors forward to `period` (never back), for an
 * invoice paid at `at`. Returns the rows matched. An invoice older than the
 * subscription state on the row changes nothing: that state already
 * carries the period.
 */
export async function advanceUserBillingPeriod(_by: SystemActor, tx: TxHandle | undefined, customerId: string, subscriptionId: string, period: { start: Date, end: Date }, at: Date): Promise<number> {
  const db = executor(tx)
  const result = await db.update(users)
    .set({ stripeCurrentPeriodStart: period.start, planValidUntil: period.end })
    .where(and(
      eq(users.stripeCustomerId, customerId),
      eq(users.stripeSubscriptionId, subscriptionId),
      or(isNull(users.planValidUntil), lt(users.planValidUntil, period.end)),
      stateNotNewerThan(at)
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
export async function getUserCheckoutBilling(self: UserScope): Promise<{
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
  }).from(users).where(eq(users.id, self.userId)).limit(1)
  return rows[0] ?? null
}

/**
 * A billing-period switch the user made on their live subscription
 * (already applied in Stripe), so their pages show it at once; the
 * `customer.subscription.updated` webhook writes the same state. Only
 * the subscription the row tracks is touched.
 */
export async function recordOwnPlanChange(self: UserScope, subscriptionId: string, change: {
  interval: BillingInterval
  cancelAt: Date | null
  period: { start: Date, end: Date } | null
  /** Stripe's time of the change: events older than it are of the previous state. */
  at: Date
}): Promise<void> {
  await useDatabase().update(users)
    .set({
      billingInterval: change.interval,
      planCancelAt: change.cancelAt,
      subscriptionEventAt: change.at,
      ...(change.period ? { stripeCurrentPeriodStart: change.period.start, planValidUntil: change.period.end } : {})
    })
    .where(and(eq(users.id, self.userId), eq(users.stripeSubscriptionId, subscriptionId)))
}

/** What the profile and pricing pages show of the user's own subscription. */
export async function getOwnSubscriptionFacts(self: UserScope): Promise<{ billingInterval: BillingInterval | null, planCancelAt: Date | null, subscriptionStatus: StripeSubscriptionStatus | null } | null> {
  return (await useDatabase().select({ billingInterval: users.billingInterval, planCancelAt: users.planCancelAt, subscriptionStatus: users.subscriptionStatus })
    .from(users).where(eq(users.id, self.userId)).limit(1))[0] ?? null
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
