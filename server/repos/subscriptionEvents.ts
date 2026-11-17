import { asc, eq } from 'drizzle-orm'
import { subscriptionEvents } from '../db/schema'
import { executor, useDatabase, type TxHandle } from '../db/client'
import type { SystemActor, UserScope } from './proofs'
import type { BillingInterval, Currency, PaidPlanName } from '~~/shared/config/pricing'

// Subscription history (`subscription_events`): append-only, written by the
// Stripe webhook; anonymised, never updated otherwise. See the schema
// comment in `server/db/schema/billing.ts`.

export type SubscriptionEventKind = 'started' | 'changed' | 'cancel_scheduled' | 'cancel_revoked' | 'ended'

export interface NewSubscriptionEvent {
  kind: SubscriptionEventKind
  subject: { kind: 'user', userId: number } | { kind: 'workspace', workspaceId: string }
  plan: PaidPlanName
  interval: BillingInterval
  currency: Currency
  seats: number
  stripeSubscriptionId: string
  stripeEventId: string
  occurredAt: Date
}

/** Append one step; a redelivered event or a second start / end of the same subscription adds nothing. */
export async function recordSubscriptionEvent(_by: SystemActor, tx: TxHandle | undefined, e: NewSubscriptionEvent): Promise<boolean> {
  const rows = await executor(tx).insert(subscriptionEvents).values({
    kind: e.kind,
    subjectType: e.subject.kind,
    userId: e.subject.kind === 'user' ? e.subject.userId : null,
    workspaceId: e.subject.kind === 'workspace' ? e.subject.workspaceId : null,
    plan: e.plan,
    interval: e.interval,
    currency: e.currency,
    seats: e.seats,
    stripeSubscriptionId: e.stripeSubscriptionId,
    stripeEventId: e.stripeEventId,
    occurredAt: e.occurredAt
  }).onConflictDoNothing().returning({ id: subscriptionEvents.id })
  return rows.length > 0
}

/** The user's own personal subscription history, oldest first (data export). */
export async function listSubscriptionEventsOfUser(user: UserScope): Promise<Array<{
  kind: SubscriptionEventKind
  plan: PaidPlanName
  interval: BillingInterval
  currency: Currency
  occurredAt: Date
}>> {
  return useDatabase().select({
    kind: subscriptionEvents.kind,
    plan: subscriptionEvents.plan,
    interval: subscriptionEvents.interval,
    currency: subscriptionEvents.currency,
    occurredAt: subscriptionEvents.occurredAt
  }).from(subscriptionEvents)
    .where(eq(subscriptionEvents.userId, user.userId))
    .orderBy(asc(subscriptionEvents.occurredAt), asc(subscriptionEvents.id))
}

/**
 * Account purge: the user's rows keep plan, period, currency and time for
 * the revenue history, without the account or the Stripe subscription id.
 * Returns how many rows were anonymised.
 */
export async function anonymiseSubscriptionEventsOfUser(user: UserScope): Promise<number> {
  const rows = await useDatabase().update(subscriptionEvents)
    .set({ userId: null, stripeSubscriptionId: null, stripeEventId: null })
    .where(eq(subscriptionEvents.userId, user.userId))
    .returning({ id: subscriptionEvents.id })
  return rows.length
}
