import { and, eq, isNotNull, isNull, lt, lte, or } from 'drizzle-orm'
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
 * The subscription user `userId` tracks, read with the user row locked
 * until the webhook's transaction ends: two checkouts of one user that
 * complete at once are bound one after the other, so the second sees the
 * subscription the first bound. Null when the row tracks none (or is gone).
 */
export async function lockTrackedSubscriptionOfUser(_by: SystemActor, tx: TxHandle | undefined, userId: number): Promise<string | null> {
  const rows = await executor(tx).select({ subscriptionId: users.stripeSubscriptionId })
    .from(users)
    .where(eq(users.id, userId))
    .for('update')
  return rows[0]?.subscriptionId ?? null
}

/**
 * The subscription the customer's user row tracks (`stripe_subscription_id`),
 * or null when the customer maps to no user or the row tracks none.
 */
export async function findTrackedUserSubscription(_by: SystemActor, customerId: string, tx?: TxHandle): Promise<string | null> {
  const rows = await executor(tx).select({ subscriptionId: users.stripeSubscriptionId })
    .from(users)
    .where(eq(users.stripeCustomerId, customerId))
    .limit(1)
  return rows[0]?.subscriptionId ?? null
}

/**
 * The user's tracked subscription `subscriptionId` ended at `at`: back to
 * Free, the Stripe anchors cleared (customer and currency stay for a later
 * purchase). Only the subscription the row tracks ends the plan: another
 * subscription of the same customer (a duplicate, an old one) changes
 * nothing, and neither does any subscription while the row tracks none.
 * Not applied when the row holds newer state either. Returns the rows
 * matched.
 */
export async function endUserSubscription(_by: SystemActor, tx: TxHandle | undefined, customerId: string, subscriptionId: string, at: Date): Promise<number> {
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
    .where(and(eq(users.stripeCustomerId, customerId), eq(users.stripeSubscriptionId, subscriptionId), stateNotNewerThan(at)))
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

/**
 * The user took back the cancellation of their live subscription (already
 * applied in Stripe): it renews again. The webhook writes the same state.
 */
export async function recordOwnPlanResumed(self: UserScope, subscriptionId: string, at: Date): Promise<void> {
  await useDatabase().update(users)
    .set({ planCancelAt: null, subscriptionEventAt: at })
    .where(and(eq(users.id, self.userId), eq(users.stripeSubscriptionId, subscriptionId)))
}

/** What the profile and pricing pages show of the user's own subscription. */
export async function getOwnSubscriptionFacts(self: UserScope): Promise<{ billingInterval: BillingInterval | null, billingCurrency: Currency | null, planCancelAt: Date | null, subscriptionStatus: StripeSubscriptionStatus | null } | null> {
  return (await useDatabase().select({ billingInterval: users.billingInterval, billingCurrency: users.billingCurrency, planCancelAt: users.planCancelAt, subscriptionStatus: users.subscriptionStatus })
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

/**
 * Personal subscriptions whose row no Stripe event or in-app change has
 * written yet and that hold no end date: `backfillSubscriptionCancelDates`
 * asks Stripe whether they were cancelled.
 */
export async function listUserSubscriptionsWithoutCancelState(_by: SystemActor): Promise<Array<{ userId: number, subscriptionId: string }>> {
  const rows = await useDatabase().select({ userId: users.id, subscriptionId: users.stripeSubscriptionId }).from(users)
    .where(and(isNotNull(users.stripeSubscriptionId), isNull(users.subscriptionEventAt), isNull(users.planCancelAt)))
  return rows.flatMap(r => r.subscriptionId ? [{ userId: r.userId, subscriptionId: r.subscriptionId }] : [])
}

/** Store the end date Stripe reports for a cancelled subscription, unless an event has written the row meanwhile. */
export async function backfillUserPlanCancelAt(_by: SystemActor, userId: number, subscriptionId: string, cancelAt: Date): Promise<number> {
  return (await useDatabase().update(users).set({ planCancelAt: cancelAt })
    .where(and(eq(users.id, userId), eq(users.stripeSubscriptionId, subscriptionId), isNull(users.subscriptionEventAt), isNull(users.planCancelAt)))
    .returning({ id: users.id })).length
}
