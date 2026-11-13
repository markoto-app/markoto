import { and, eq, isNotNull, lt, or } from 'drizzle-orm'
import { processedWebhookEvents, pendingStripeEvents } from '../db/schema'
import { executor, useDatabase, type TxHandle } from '../db/client'
import type { OrderSensitiveStripeEvent } from '~~/shared/contracts/stripe'
import type { SystemActor } from './proofs'

// The Stripe webhook's bookkeeping: delivered event ids (replay protection)
// and the stash of order-sensitive events that arrived before their
// customer was bound. Always written inside the webhook's per-event
// transaction.

/**
 * Record a delivered event. Atomic INSERT with ON CONFLICT DO NOTHING:
 * false when this event id was processed before.
 */
export async function recordProcessedWebhookEvent(_by: SystemActor, tx: TxHandle | undefined, eventId: string, type: string): Promise<boolean> {
  const db = executor(tx)
  const inserted = await db.insert(processedWebhookEvents)
    .values({ eventId, type })
    .onConflictDoNothing({ target: processedWebhookEvents.eventId })
    .returning({ eventId: processedWebhookEvents.eventId })
  return inserted.length > 0
}

/** Keep the full payload of an event whose customer isn't bound yet (first delivery wins). */
export async function stashPendingStripeEvent(_by: SystemActor, tx: TxHandle | undefined, event: OrderSensitiveStripeEvent, customerId: string): Promise<void> {
  const db = executor(tx)
  await db.insert(pendingStripeEvents)
    .values({
      eventId: event.id,
      customerId,
      type: event.type,
      payload: event
    })
    .onConflictDoNothing({ target: pendingStripeEvents.eventId })
}

/** The customer's stashed events not replayed yet, oldest first. */
export async function listPendingStripeEvents(_by: SystemActor, tx: TxHandle | undefined, customerId: string): Promise<Array<{ eventId: string, payload: OrderSensitiveStripeEvent }>> {
  const db = executor(tx)
  return db.select({
    eventId: pendingStripeEvents.eventId,
    payload: pendingStripeEvents.payload
  })
    .from(pendingStripeEvents)
    .where(and(
      eq(pendingStripeEvents.customerId, customerId),
      eq(pendingStripeEvents.processed, false)
    ))
    .orderBy(pendingStripeEvents.receivedAt)
}

/** Flag a stashed event replayed (kept for a week so ops can audit what was late-applied). */
export async function markPendingStripeEventProcessed(_by: SystemActor, tx: TxHandle | undefined, eventId: string): Promise<void> {
  const db = executor(tx)
  await db.update(pendingStripeEvents)
    .set({ processed: true, processedAt: new Date() })
    .where(eq(pendingStripeEvents.eventId, eventId))
}

/**
 * Retention of the webhook bookkeeping: delivered event ids after 90 days,
 * replayed stash rows a week after their replay (audit grace), never-
 * replayed ones after 30 days. Returns the rows deleted per table.
 */
export async function pruneWebhookEvents(_by: SystemActor, cutoffs: { processedBefore: Date, replayedBefore: Date, unreplayedBefore: Date }): Promise<{ processedDeleted: number, pendingDeleted: number }> {
  const db = useDatabase()
  const processed = await db.delete(processedWebhookEvents)
    .where(lt(processedWebhookEvents.processedAt, cutoffs.processedBefore))
    .returning({ eventId: processedWebhookEvents.eventId })
  const pending = await db.delete(pendingStripeEvents)
    .where(or(
      and(eq(pendingStripeEvents.processed, true), isNotNull(pendingStripeEvents.processedAt), lt(pendingStripeEvents.processedAt, cutoffs.replayedBefore)),
      and(eq(pendingStripeEvents.processed, false), lt(pendingStripeEvents.receivedAt, cutoffs.unreplayedBefore))
    ))
    .returning({ eventId: pendingStripeEvents.eventId })
  return { processedDeleted: processed.length, pendingDeleted: pending.length }
}
