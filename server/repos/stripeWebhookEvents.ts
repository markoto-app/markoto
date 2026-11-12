import { and, eq } from 'drizzle-orm'
import { processedWebhookEvents, pendingStripeEvents } from '../db/schema'
import type { useDatabase } from '../utils/platform/database'
import type { OrderSensitiveStripeEvent } from '~~/shared/contracts/stripe'

// The Stripe webhook's bookkeeping: delivered event ids (replay protection)
// and the stash of order-sensitive events that arrived before their
// customer was bound. Always written inside the webhook's per-event
// transaction.

type Db = ReturnType<typeof useDatabase>
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
type DbOrTx = Db | Tx

/**
 * Record a delivered event. Atomic INSERT with ON CONFLICT DO NOTHING:
 * false when this event id was processed before.
 */
export async function recordProcessedWebhookEvent(db: DbOrTx, eventId: string, type: string): Promise<boolean> {
  const inserted = await db.insert(processedWebhookEvents)
    .values({ eventId, type })
    .onConflictDoNothing({ target: processedWebhookEvents.eventId })
    .returning({ eventId: processedWebhookEvents.eventId })
  return inserted.length > 0
}

/** Keep the full payload of an event whose customer isn't bound yet (first delivery wins). */
export async function stashPendingStripeEvent(db: DbOrTx, event: OrderSensitiveStripeEvent, customerId: string): Promise<void> {
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
export async function listPendingStripeEvents(db: DbOrTx, customerId: string): Promise<Array<{ eventId: string, payload: OrderSensitiveStripeEvent }>> {
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
export async function markPendingStripeEventProcessed(db: DbOrTx, eventId: string): Promise<void> {
  await db.update(pendingStripeEvents)
    .set({ processed: true, processedAt: new Date() })
    .where(eq(pendingStripeEvents.eventId, eventId))
}
