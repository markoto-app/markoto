import type Stripe from 'stripe'
import * as Sentry from '@sentry/nuxt'
import { listPendingStripeEvents, markPendingStripeEventProcessed, recordProcessedWebhookEvent, stashPendingStripeEvent } from '../../repos/stripeWebhookEvents'
import { isOrderSensitiveStripeEvent, type OrderSensitiveStripeEvent } from '~~/shared/contracts/stripe'
import { subjectForCustomer } from './stripeEvents/billingSubjects'
import { runStripeEventHandler } from './stripeEvents/eventHandlers'
import type { TxHandle, DeferredAfterCommit, StripeHandlerOptions } from './stripeEvents/types'
import { withTransaction } from '../../repos/transaction'
import { useLogger } from '../platform/logger'
import { system } from '../../repos/proofs'

/** Stripe's webhook writes billing state for whichever customer the event names. */
const STRIPE = system('stripe-webhook')

const log = useLogger('stripe-webhook')

// Stripe webhook entry: replay protection, the out-of-order stash, one
// transaction per event, and the after-commit queue. The handlers are
// pure functions of `(event, stripe) → DB mutation`, one module per event
// family under `./stripeEvents/` (checkout, credit top-ups, subscription
// lifecycle, invoices), dispatched through the table in
// `stripeEvents/eventHandlers.ts`. Kept separate from the HTTP endpoint so
// tests can call them directly without going through signature
// verification for every case. The endpoint
// (`server/api/webhooks/stripe.post.ts`) does the signature check first and
// then dispatches here.
//
// Events handled:
//   - `checkout.session.completed`: first subscription signup. We
//     learn the customer_id + subscription_id here and stamp them
//     onto the user row (or the workspace's subscription row); a
//     payment-mode session is a credit top-up.
//   - `customer.subscription.created|updated`: plan changes, cancel-at-
//     period-end toggles, period rollover. Idempotent: replay with
//     same data → same state.
//   - `customer.subscription.deleted`: subscription ended (either
//     user cancelled immediately or period-end arrived on a
//     scheduled cancel). Flip plan back to Free + null the stripe
//     anchor so the resolver uses the calendar fallback.
//   - `invoice.paid`: renewal charge succeeded. Update the period
//     start/end so the billing anchor advances to the new cycle.
//   - `invoice.payment_failed`: retained for observability; we do
//     NOT downgrade on first failure (Stripe retries automatically).
//     The user's plan stays until the eventual subscription.deleted.
//   - `checkout.session.async_payment_succeeded|failed`,
//     `charge.refunded`: delayed and refunded credit top-ups.

/**
 * Pull the customer id off an event whose object keys on it (subscription,
 * invoice, checkout session). Used to (a) detect out-of-order subscription events
 * and (b) drain the pending-events stash on checkout binding.
 */
function extractCustomerId(event: OrderSensitiveStripeEvent | Stripe.CheckoutSessionCompletedEvent): string | null {
  const cust = event.data.object.customer
  if (typeof cust === 'string') return cust
  return cust?.id ?? null
}

/**
 * Drain stashed orphan events for a customer that's now bound to a
 * user or a workspace subscription. Called from inside `dispatchStripeEvent` after a
 * `checkout.session.completed` finishes. Each stashed payload is
 * replayed through `runStripeEventHandler` against the same transaction; rows
 * are then flipped to `processed=true` (kept for a week so ops can
 * audit what was late-applied).
 */
async function drainPendingEvents(
  customerId: string,
  opts: StripeHandlerOptions
): Promise<number> {
  const rows = await listPendingStripeEvents(STRIPE, opts.db, customerId)

  for (const row of rows) {
    try {
      await runStripeEventHandler(row.payload, opts)
      await markPendingStripeEventProcessed(STRIPE, opts.db, row.eventId)
      log.info('drained stashed event', { eventId: row.eventId, customerId })
    } catch (e) {
      // Don't propagate: one bad stashed event shouldn't block the
      // rest from replaying. Sentry capture so ops sees it; the row
      // stays processed=false and the daily sweep eventually reaps it.
      log.warn('drain failed for stashed event', { eventId: row.eventId, err: e })
      Sentry.captureException(e, {
        tags: { component: 'stripeWebhook', event: 'stash_drain_failed', stripeEventId: row.eventId }
      })
    }
  }
  return rows.length
}

/**
 * Dispatch a verified event to the matching handler. Returns the
 * handler's result so the HTTP endpoint can log it (for ops telemetry)
 * and respond 200 to Stripe (any non-200 triggers a Stripe retry).
 *
 * Replay protection: BEFORE running the handler we INSERT into
 * `processed_webhook_events`. On conflict (event.id already present)
 * we short-circuit: Stripe is satisfied by 200 and stops retrying,
 * but we don't re-apply the event's UPDATEs. This preserves manual
 * ops corrections that landed between the original delivery and a
 * retried redelivery.
 *
 * Out-of-order stash: subscription.* / invoice.* events that arrive
 * BEFORE checkout.session.completed (i.e. before
 * `users.stripe_customer_id` is set) match zero rows. We stash the
 * full payload in `pending_stripe_events` and drain on the eventual
 * checkout. Defensive belt-and-braces around the live-fetch in
 * `handleCheckoutSessionCompleted`: if anyone removes that
 * subscriptions.retrieve, the stash keeps state convergent.
 *
 * Everything runs in ONE transaction so a crash mid-handler rolls
 * back BOTH the user UPDATE and the dedup INSERT, Stripe's retry
 * then succeeds.
 *
 * `stripe` is the SDK client, only `handleCheckoutSessionCompleted`
 * uses it. Passed explicitly so unit tests can inject a mock.
 */
export async function dispatchStripeEvent(
  event: Stripe.Event,
  opts: {
    stripe: Stripe
  }
): Promise<{ handled: boolean, detail?: unknown, replayed?: boolean, stashed?: boolean }> {
  // Handlers push LiteLLM key-sync closures here (instead of
  // running them inline): the surrounding TX holds an exclusive lock
  // on the user row, and `updateUserKeyBudget` opens its own pool
  // connection to UPDATE the same row. We flush these AFTER the TX
  // commits so the lock has been released.
  const deferAfterCommit: DeferredAfterCommit = []
  const result = await withTransaction(async (tx: TxHandle) => {
    // Step 1: dedup. Atomic INSERT with ON CONFLICT DO NOTHING; false
    // when this event.id has been processed before. Short-circuit so
    // the row stays at whatever state it's in (including any
    // out-of-band ops correction).
    if (!(await recordProcessedWebhookEvent(STRIPE, tx, event.id, event.type))) {
      log.info('replay short-circuited', { eventId: event.id })
      return { handled: true, replayed: true }
    }

    // Step 2: out-of-order stash. For subscription.* / invoice.*
    // events that arrive BEFORE the user is bound to a Stripe
    // customer, store the full payload and bail. The eventual
    // checkout.session.completed drains the stash. The set of
    // order-sensitive types is owned by `shared/contracts/stripe.ts`;
    // every one of them has a handler (`stripeEvents/eventHandlers.ts`).
    if (isOrderSensitiveStripeEvent(event)) {
      const customerId = extractCustomerId(event)
      if (customerId) {
        // Probe: does a user or a workspace subscription own this
        // customer id? If not, stash.
        if (await subjectForCustomer(customerId, tx) === null) {
          await stashPendingStripeEvent(STRIPE, tx, event, customerId)
          log.info('stashed out-of-order event for unbound customer', { eventType: event.type, customerId, eventId: event.id })
          return { handled: true, stashed: true }
        }
      }
    }

    // Step 3: dispatch the event normally.
    const result = await runStripeEventHandler(event, { ...opts, db: tx, deferAfterCommit })

    // Step 4: if this was a checkout, drain any stashed events that
    // were waiting for this customer to be bound.
    if (event.type === 'checkout.session.completed') {
      const customerId = extractCustomerId(event)
      if (customerId) {
        const drained = await drainPendingEvents(customerId, { ...opts, db: tx, deferAfterCommit })
        if (drained > 0) {
          const detail = result.detail ?? {}
          return { ...result, detail: { ...detail, drained } }
        }
      }
    }

    return result
  })

  // Flush deferred LiteLLM key syncs. Each closure already swallows its
  // own errors + reports to Sentry, running them sequentially keeps
  // the side-effect ordering predictable for tests and ops.
  for (const fn of deferAfterCommit) {
    await fn()
  }

  return result
}
