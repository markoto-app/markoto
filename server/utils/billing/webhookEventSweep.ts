import * as Sentry from '@sentry/nuxt'
import { and, eq, isNotNull, lt, or } from 'drizzle-orm'
import { processedWebhookEvents, pendingStripeEvents } from '../../db/schema'
import { useDatabase } from '../platform/database'

// Webhook event-table sweeper. Two responsibilities:
//
//   1. Prune `processed_webhook_events` rows older than 90 days. Stripe
//      replays only within ~3 days, but we keep extra for forensic
//      "did we see this event in the suspect window?" investigations.
//      Past 90 days the row is pure storage cost.
//
//   2. Prune `pending_stripe_events` rows in two flavours:
//        - processed=true rows older than 7 days (replayed long ago,
//          ops audit window has expired).
//        - processed=false rows older than 30 days (the customer never
//          got a checkout binding — abandoned signup or a delivery
//          shape we'll never reconcile; keep our stash bounded).
//
// Standalone module so tests can import it without triggering
// `defineNitroPlugin`.

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000

/**
 * Run one sweep tick. Returns the number of rows deleted across both
 * tables (mostly for ops logging — caller doesn't act on the value).
 */
export async function runWebhookEventSweep(): Promise<{ processedDeleted: number, pendingDeleted: number }> {
  const db = useDatabase()
  let processedDeleted = 0
  let pendingDeleted = 0
  try {
    const now = Date.now()
    const processedCutoff = new Date(now - NINETY_DAYS_MS)
    const pendingProcessedCutoff = new Date(now - SEVEN_DAYS_MS)
    const pendingUnprocessedCutoff = new Date(now - THIRTY_DAYS_MS)

    const a = await db.delete(processedWebhookEvents)
      .where(lt(processedWebhookEvents.processedAt, processedCutoff))
      .returning({ eventId: processedWebhookEvents.eventId })
    processedDeleted = a.length

    const b = await db.delete(pendingStripeEvents)
      .where(or(
        and(
          eq(pendingStripeEvents.processed, true),
          // processedAt is nullable for unprocessed rows; we only
          // delete here if processedAt itself is past the cutoff so
          // a freshly-flipped row gets the full week of audit grace.
          isNotNull(pendingStripeEvents.processedAt),
          lt(pendingStripeEvents.processedAt, pendingProcessedCutoff)
        ),
        and(
          eq(pendingStripeEvents.processed, false),
          lt(pendingStripeEvents.receivedAt, pendingUnprocessedCutoff)
        )
      ))
      .returning({ eventId: pendingStripeEvents.eventId })
    pendingDeleted = b.length

    if (processedDeleted + pendingDeleted > 0) {
      console.log(`[webhook-event-sweep] pruned processed=${processedDeleted} pending=${pendingDeleted}`)
    }
  } catch (e) {
    console.warn('[webhook-event-sweep] sweep failed:', e instanceof Error ? e.message : e)
    Sentry.captureException(e, { tags: { component: 'webhook-event-sweep', event: 'sweep_failed' } })
  }
  return { processedDeleted, pendingDeleted }
}
