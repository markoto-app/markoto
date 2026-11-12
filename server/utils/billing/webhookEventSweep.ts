import * as Sentry from '@sentry/nuxt'
import { pruneWebhookEvents } from '../../repos/stripeWebhookEvents'
import { system } from '../../repos/proofs'
import { DAY_MS } from '~~/shared/config/units'
import { useLogger } from '../platform/logger'

const log = useLogger('webhook-event-sweep')

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
//          got a checkout binding, abandoned signup or a delivery
//          shape we'll never reconcile; keep our stash bounded).
//
// Standalone module so tests can import it without triggering
// `defineNitroPlugin`.

const NINETY_DAYS_MS = 90 * DAY_MS
const SEVEN_DAYS_MS = 7 * DAY_MS
const THIRTY_DAYS_MS = 30 * DAY_MS

/**
 * Run one sweep tick. Returns the number of rows deleted across both
 * tables (mostly for ops logging, caller doesn't act on the value).
 */
export async function runWebhookEventSweep(): Promise<{ processedDeleted: number, pendingDeleted: number }> {
  let processedDeleted = 0
  let pendingDeleted = 0
  try {
    const now = Date.now()
    ;({ processedDeleted, pendingDeleted } = await pruneWebhookEvents(system('stripe-webhook'), {
      processedBefore: new Date(now - NINETY_DAYS_MS),
      replayedBefore: new Date(now - SEVEN_DAYS_MS),
      unreplayedBefore: new Date(now - THIRTY_DAYS_MS)
    }))

    if (processedDeleted + pendingDeleted > 0) {
      log.info('pruned webhook events', { processed: processedDeleted, pending: pendingDeleted })
    }
  } catch (e) {
    log.warn('sweep failed', { err: e })
    Sentry.captureException(e, { tags: { component: 'webhook-event-sweep', event: 'sweep_failed' } })
  }
  return { processedDeleted, pendingDeleted }
}
