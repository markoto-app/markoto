import type Stripe from 'stripe'
import { and, eq } from 'drizzle-orm'
import * as Sentry from '@sentry/nuxt'
import { users, processedWebhookEvents, pendingStripeEvents } from '../db/schema'
import { useDatabase } from './database'
import type { PlanName } from '~~/shared/config/tiers'
import { isOrderSensitiveStripeEvent } from '~~/shared/contracts/stripe'
import { updateUserKeyBudget, resetUserKeySpend } from './litellmKeys'

// Drizzle's node-postgres transaction handle — same shape as the
// top-level `db` for our usage but typed distinctly. We accept either
// for handler reuse: the dispatcher wraps the whole event in a single
// transaction so the dedup INSERT and the user UPDATE commit together.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbOrTx = any

// Phase 7: handlers queue side-effects that must run AFTER the
// surrounding transaction commits — primarily LiteLLM virtual-key
// budget syncs. Calling `updateUserKeyBudget` inline acquires its own
// pool connection while the surrounding TX still holds an exclusive
// lock on the same `users` row, deadlocking until `statement_timeout`
// fires. The dispatcher walks this queue after the TX commits and
// runs each closure best-effort.
type DeferredAfterCommit = (() => Promise<void>)[]

// Stripe webhook handlers — pure functions of `(event, config) → DB
// mutation`. Kept separate from the HTTP endpoint so tests can call
// them directly without going through signature verification for
// every case. The endpoint (`server/api/webhooks/stripe.post.ts`)
// does the signature check first and then dispatches here.
//
// Events handled:
//   - `checkout.session.completed` — first subscription signup. We
//     learn the customer_id + subscription_id here and stamp them
//     onto the user row.
//   - `customer.subscription.updated` — plan changes, cancel-at-
//     period-end toggles, period rollover. Idempotent: replay with
//     same data → same state.
//   - `customer.subscription.deleted` — subscription ended (either
//     user cancelled immediately or period-end arrived on a
//     scheduled cancel). Flip plan back to Free + null the stripe
//     anchor so the resolver uses the calendar fallback.
//   - `invoice.paid` — renewal charge succeeded. Update the period
//     start/end so the Model C billing anchor advances to the new
//     cycle (counter key changes → fresh quota row).
//   - `invoice.payment_failed` — retained for observability; we do
//     NOT downgrade on first failure (Stripe retries automatically).
//     The user's plan stays until the eventual subscription.deleted.

/**
 * Map a Stripe Price ID → our internal plan name. Read from runtime
 * config so ops can swap price IDs without code changes (e.g. annual
 * vs monthly). Unknown price IDs return `null` so the handler can
 * log + skip rather than mis-assign a plan.
 */
export function priceIdToPlan(priceId: string | null | undefined, config: {
  pricePro: string
  priceMax: string
  priceUltra: string
}): PlanName | null {
  if (!priceId) return null
  if (priceId === config.pricePro) return 'pro'
  if (priceId === config.priceMax) return 'max'
  if (priceId === config.priceUltra) return 'ultra'
  return null
}

interface UpdateUserArgs {
  where: { stripeCustomerId?: string, id?: number }
  set: Partial<{
    plan: PlanName
    planValidUntil: Date | null
    stripeCurrentPeriodStart: Date | null
    stripeCustomerId: string | null
    stripeSubscriptionId: string | null
  }>
}

/**
 * One-shot user update by customer id OR by internal user id. Used
 * by every webhook handler. Returns the number of rows matched (0
 * when the customer id doesn't map to a user — logged but not
 * fatal: old customers from prior test runs, deleted accounts, etc.).
 *
 * Accepts an optional `db` so the dispatcher can pass a transaction
 * handle. When omitted, falls back to the global pool — used by direct
 * unit-test callers that don't go through `dispatchStripeEvent`.
 */
async function updateUser(opts: UpdateUserArgs, db?: DbOrTx): Promise<number> {
  const handle = db ?? useDatabase()
  const where = opts.where.id !== undefined
    ? eq(users.id, opts.where.id)
    : eq(users.stripeCustomerId, opts.where.stripeCustomerId!)
  const result = await handle.update(users).set(opts.set).where(where).returning({ id: users.id })
  return result.length
}

/**
 * `checkout.session.completed` handler. Fires once per successful
 * checkout. Sets the user's customer_id, subscription_id, plan, and
 * period anchors all at once.
 *
 * Why fetch the subscription here (and not defer to
 * customer.subscription.updated): Stripe fires BOTH events on a
 * successful checkout, and their delivery order is NOT guaranteed.
 * If subscription.updated arrives first, its handler looks up the
 * user via `stripe_customer_id` — which isn't stamped yet because
 * that's THIS handler's job. The update silently drops, and the user
 * sits on Free caps despite paying. By retrieving the subscription
 * synchronously here (indexed by `subscriptionId` from the session
 * object, identified by `client_reference_id` = userId), we apply
 * the full state in one DB write. Subsequent subscription.updated
 * events become idempotent no-ops.
 */
export async function handleCheckoutSessionCompleted(
  event: Stripe.CheckoutSessionCompletedEvent,
  opts: {
    stripe: Stripe
    config: { pricePro: string, priceMax: string, priceUltra: string }
    db?: DbOrTx
    deferAfterCommit?: DeferredAfterCommit
  }
): Promise<{ matched: number, plan: PlanName | null }> {
  const session = event.data.object
  const userId = session.client_reference_id ? Number(session.client_reference_id) : null
  if (!userId || Number.isNaN(userId)) {
    const msg = `[stripe/webhook] checkout.session.completed with no client_reference_id: session=${session.id}`
    console.warn(msg)
    Sentry.captureMessage(msg, {
      level: 'warning',
      tags: { component: 'stripeWebhook', event: 'checkout_missing_client_ref' }
    })
    return { matched: 0, plan: null }
  }
  const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id ?? null
  const subscriptionId = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id ?? null
  if (!customerId) {
    const msg = `[stripe/webhook] checkout.session.completed missing customer: session=${session.id}`
    console.warn(msg)
    Sentry.captureMessage(msg, {
      level: 'warning',
      tags: { component: 'stripeWebhook', event: 'checkout_missing_customer' }
    })
    return { matched: 0, plan: null }
  }

  // Non-subscription checkouts (e.g. one-off product purchases) have
  // no subscription to read. We still stamp the customer id so
  // future subscription flows can reuse the same customer record.
  if (!subscriptionId) {
    const matched = await updateUser({
      where: { id: userId },
      set: { stripeCustomerId: customerId }
    }, opts.db)
    return { matched, plan: null }
  }

  // Fetch the full subscription. If this fails (Stripe API blip), we
  // throw → webhook returns 500 → Stripe retries with backoff. The
  // DB write below is a single UPDATE so partial-apply isn't a
  // concern — either the whole row updates or nothing does.
  const sub = await opts.stripe.subscriptions.retrieve(subscriptionId)
  const item = sub.items.data[0]
  const priceId = item?.price?.id ?? null
  const plan = priceIdToPlan(priceId, opts.config)
  // Stripe API version `2025-01-27.acacia` (pinned in the client)
  // carries `current_period_start` / `current_period_end` on the
  // subscription ITEM, not the subscription root. Cast because the
  // SDK's root type still exposes them during the transition period.
  const itemWithPeriod = item as unknown as { current_period_start?: number, current_period_end?: number }
  const periodStart = itemWithPeriod?.current_period_start
    ? new Date(itemWithPeriod.current_period_start * 1000)
    : null
  const periodEnd = itemWithPeriod?.current_period_end
    ? new Date(itemWithPeriod.current_period_end * 1000)
    : null

  // If the price maps to no known plan (e.g. price ID rotated but
  // config not updated), still stamp customer/sub ids so we can
  // reconcile manually. Don't set `plan` from a bogus mapping.
  const setFields: UpdateUserArgs['set'] = {
    stripeCustomerId: customerId,
    stripeSubscriptionId: subscriptionId
  }
  if (plan) setFields.plan = plan
  if (periodStart) setFields.stripeCurrentPeriodStart = periodStart
  if (periodEnd) setFields.planValidUntil = periodEnd

  const matched = await updateUser({
    where: { id: userId },
    set: setFields
  }, opts.db)

  // Phase 6: sync LiteLLM virtual-key budget to the new plan. Lazy-
  // creates the key if the user hasn't done their first AI call yet.
  // **Deferred until after the surrounding TX commits** — calling
  // `updateUserKeyBudget` inline would self-deadlock against the row
  // lock held by the user UPDATE above (Phase 7 fix).
  if (plan && opts.deferAfterCommit) {
    opts.deferAfterCommit.push(async () => {
      try {
        await updateUserKeyBudget(userId, plan)
      } catch (e) {
        console.warn(`[stripe/webhook] LiteLLM key budget sync failed (user=${userId} plan=${plan}):`, e instanceof Error ? e.message : e)
        Sentry.captureException(e, {
          tags: { component: 'stripeWebhook', event: 'litellm_key_sync_failed', userId: String(userId) }
        })
      }
    })
  }

  return { matched, plan }
}

/**
 * `customer.subscription.updated` handler. Triggered for: initial
 * creation, plan changes, `cancel_at_period_end` toggles, period
 * rollover. We use the SAME handler as `customer.subscription.created`
 * because they carry identical shapes.
 *
 * - `plan` ← mapped from the first subscription item's price id
 * - `stripeCurrentPeriodStart` ← `subscription.current_period_start`
 * - `planValidUntil` ← `subscription.current_period_end`
 *
 * Scheduled downgrades (`cancel_at_period_end=true`): we do NOT flip
 * the plan yet — the user keeps their paid tier through period end.
 * The actual downgrade happens on `customer.subscription.deleted`
 * (which fires when the period ends).
 */
export async function handleSubscriptionUpdated(
  event: Stripe.CustomerSubscriptionUpdatedEvent | Stripe.CustomerSubscriptionCreatedEvent,
  config: { pricePro: string, priceMax: string, priceUltra: string },
  db?: DbOrTx,
  deferAfterCommit?: DeferredAfterCommit
): Promise<{ matched: number, plan: PlanName | null }> {
  const sub = event.data.object
  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id
  const item = sub.items.data[0]
  const priceId = item?.price?.id ?? null
  const plan = priceIdToPlan(priceId, config)
  if (!plan) {
    const msg = `[stripe/webhook] subscription.${event.type.split('.').pop()} unknown price: ${priceId} (sub=${sub.id})`
    console.warn(msg)
    Sentry.captureMessage(msg, {
      level: 'warning',
      tags: { component: 'stripeWebhook', event: 'unknown_price' }
    })
    return { matched: 0, plan: null }
  }
  // API version 2025-01-27.acacia: period fields on item root.
  const itemWithPeriod = item as unknown as { current_period_start?: number, current_period_end?: number }
  const setFields: UpdateUserArgs['set'] = {
    plan,
    stripeSubscriptionId: sub.id
  }
  if (itemWithPeriod?.current_period_start) {
    setFields.stripeCurrentPeriodStart = new Date(itemWithPeriod.current_period_start * 1000)
  }
  if (itemWithPeriod?.current_period_end) {
    setFields.planValidUntil = new Date(itemWithPeriod.current_period_end * 1000)
  }
  const matched = await updateUser({
    where: { stripeCustomerId: customerId },
    set: setFields
  }, db)

  // Phase 6: sync LiteLLM virtual-key budget to the new plan. Deferred
  // until after the surrounding TX commits to avoid the self-deadlock
  // against the user-row lock held by the UPDATE above (Phase 7 fix).
  if (deferAfterCommit) {
    deferAfterCommit.push(async () => {
      try {
        const userId = await getUserIdByCustomer(customerId)
        if (userId !== null) {
          await updateUserKeyBudget(userId, plan)
        }
      } catch (e) {
        console.warn(`[stripe/webhook] LiteLLM key budget sync failed (customer=${customerId} plan=${plan}):`, e instanceof Error ? e.message : e)
        Sentry.captureException(e, {
          tags: { component: 'stripeWebhook', event: 'litellm_key_sync_failed', customerId }
        })
      }
    })
  }

  return { matched, plan }
}

/**
 * `customer.subscription.deleted` handler. Revert user to Free and
 * null the Stripe anchor so the billing resolver picks the calendar-
 * month fallback (Model C defensive behaviour).
 *
 * Keep `stripeCustomerId` — future resubscriptions can re-use the
 * same customer on Stripe's side. Null `stripeSubscriptionId` because
 * the subscription no longer exists.
 */
export async function handleSubscriptionDeleted(
  event: Stripe.CustomerSubscriptionDeletedEvent,
  db?: DbOrTx,
  deferAfterCommit?: DeferredAfterCommit
): Promise<{ matched: number }> {
  const sub = event.data.object
  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id
  const matched = await updateUser({
    where: { stripeCustomerId: customerId },
    set: {
      plan: 'free',
      stripeSubscriptionId: null,
      stripeCurrentPeriodStart: null,
      planValidUntil: null
    }
  }, db)

  // Phase 6: drop LiteLLM key budget to free-tier value. Deferred to
  // post-commit (Phase 7 fix — see handleCheckoutSessionCompleted).
  if (deferAfterCommit) {
    deferAfterCommit.push(async () => {
      try {
        const userId = await getUserIdByCustomer(customerId)
        if (userId !== null) {
          await updateUserKeyBudget(userId, 'free')
        }
      } catch (e) {
        console.warn(`[stripe/webhook] LiteLLM key drop-to-free failed (customer=${customerId}):`, e instanceof Error ? e.message : e)
        Sentry.captureException(e, {
          tags: { component: 'stripeWebhook', event: 'litellm_key_sync_failed', customerId }
        })
      }
    })
  }

  return { matched }
}

/**
 * Helper: resolve `users.id` from a Stripe customer id. Used by the
 * LiteLLM key sync paths above. Returns null if no matching row.
 */
async function getUserIdByCustomer(customerId: string, db?: DbOrTx): Promise<number | null> {
  const conn = db ?? useDatabase()
  const rows = await conn.select({ id: users.id })
    .from(users)
    .where(eq(users.stripeCustomerId, customerId))
    .limit(1)
  return rows[0]?.id ?? null
}

/**
 * `invoice.paid` handler. Fires on subscription renewal. Update the
 * period anchors so the billing-period key advances to the new cycle.
 *
 * Phase 6: also resets the user's LiteLLM virtual-key spend to 0 so
 * the next AI call starts the fresh cycle at full AI Points. Idempotent
 * — replays land at the same end state.
 *
 * Skip non-subscription invoices (one-off charges etc.).
 */
export async function handleInvoicePaid(
  event: Stripe.InvoicePaidEvent,
  db?: DbOrTx,
  deferAfterCommit?: DeferredAfterCommit
): Promise<{ matched: number }> {
  const invoice = event.data.object
  // Stripe API 2025+ moved subscription off the invoice root onto
  // `parent.subscription_details.subscription`. Skip non-subscription
  // invoices (manual one-offs, etc.) — `parent` is null for those.
  const subscriptionRef = invoice.parent?.subscription_details?.subscription ?? null
  if (!subscriptionRef) {
    return { matched: 0 }
  }
  const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id ?? null
  if (!customerId) return { matched: 0 }
  // `period_start` / `period_end` on the invoice are the new cycle's
  // boundaries — use them directly. Falling back to the subscription
  // object would require an extra API round-trip.
  const periodStart = new Date(invoice.period_start * 1000)
  const periodEnd = new Date(invoice.period_end * 1000)
  const matched = await updateUser({
    where: { stripeCustomerId: customerId },
    set: {
      stripeCurrentPeriodStart: periodStart,
      planValidUntil: periodEnd
    }
  }, db)

  // Phase 6: reset LiteLLM cumulative spend to 0 so the user starts
  // the new cycle with their full AI Points balance restored. Deferred
  // to post-commit (Phase 7 fix — see handleCheckoutSessionCompleted).
  if (deferAfterCommit) {
    deferAfterCommit.push(async () => {
      try {
        const userId = await getUserIdByCustomer(customerId)
        if (userId !== null) {
          await resetUserKeySpend(userId)
        }
      } catch (e) {
        console.warn(`[stripe/webhook] LiteLLM spend reset failed (customer=${customerId}):`, e instanceof Error ? e.message : e)
        Sentry.captureException(e, {
          tags: { component: 'stripeWebhook', event: 'litellm_spend_reset_failed', customerId }
        })
      }
    })
  }

  return { matched }
}

/**
 * `invoice.payment_failed` handler. Observability-only — we do NOT
 * downgrade immediately. Stripe retries failed charges for ~3 weeks;
 * if all retries fail, Stripe fires `customer.subscription.deleted`
 * which our handler above catches. Logging here helps operators see
 * which users are in dunning.
 */
export async function handleInvoicePaymentFailed(
  event: Stripe.InvoicePaymentFailedEvent
): Promise<{ matched: number }> {
  const invoice = event.data.object
  const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id ?? null
  const msg = `[stripe/webhook] payment failed for customer=${customerId} invoice=${invoice.id} attempt=${invoice.attempt_count}`
  console.warn(msg)
  Sentry.captureMessage(msg, {
    level: 'warning',
    tags: { component: 'stripeWebhook', event: 'invoice_payment_failed' }
  })
  return { matched: 0 }
}

/**
 * Internal dispatcher — runs an event's handler against the given
 * `db` (top-level pool OR a transaction handle) without doing the
 * dedup INSERT or the out-of-order stash. Used both by the public
 * `dispatchStripeEvent` (which wraps this in a transaction + dedup)
 * AND by the drain logic in `handleCheckoutSessionCompleted` when
 * replaying stashed events for a now-bound customer.
 */
async function runHandler(
  event: Stripe.Event,
  opts: {
    stripe: Stripe
    config: { pricePro: string, priceMax: string, priceUltra: string }
    db: DbOrTx
    deferAfterCommit?: DeferredAfterCommit
  }
): Promise<{ handled: boolean, detail?: unknown }> {
  switch (event.type) {
    case 'checkout.session.completed':
      return { handled: true, detail: await handleCheckoutSessionCompleted(event, opts) }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
      return { handled: true, detail: await handleSubscriptionUpdated(event, opts.config, opts.db, opts.deferAfterCommit) }
    case 'customer.subscription.deleted':
      return { handled: true, detail: await handleSubscriptionDeleted(event, opts.db, opts.deferAfterCommit) }
    case 'invoice.paid':
      return { handled: true, detail: await handleInvoicePaid(event, opts.db, opts.deferAfterCommit) }
    case 'invoice.payment_failed':
      return { handled: true, detail: await handleInvoicePaymentFailed(event) }
    default:
      // Unhandled events are OK — Stripe sends dozens of types we
      // don't care about. Log + acknowledge so Stripe stops retrying.
      return { handled: false }
  }
}

/**
 * Pull the customer id off any of the event types that key on it.
 * Returns null for event shapes that don't carry one (e.g. unknown
 * event types). Used to (a) detect out-of-order subscription events
 * and (b) drain the pending-events stash on checkout binding.
 */
function extractCustomerId(event: Stripe.Event): string | null {
  // Cast through `unknown` because Stripe.Event.data.object is a giant
  // discriminated union (every Stripe object type) — we only care about
  // the ones that carry a `customer` field, and we already gate this
  // function behind a type-name check at the call site.
  const obj = (event.data as unknown as { object?: Record<string, unknown> })?.object
  if (!obj) return null
  const cust = (obj as { customer?: string | { id?: string } | null }).customer
  if (typeof cust === 'string') return cust
  if (cust && typeof cust === 'object' && typeof cust.id === 'string') return cust.id
  return null
}

/**
 * Drain stashed orphan events for a customer that's now bound to a
 * user row. Called from inside `dispatchStripeEvent` after a
 * `checkout.session.completed` finishes. Each stashed payload is
 * replayed through `runHandler` against the same transaction; rows
 * are then flipped to `processed=true` (kept for a week so ops can
 * audit what was late-applied).
 */
async function drainPendingEvents(
  customerId: string,
  opts: {
    stripe: Stripe
    config: { pricePro: string, priceMax: string, priceUltra: string }
    db: DbOrTx
    deferAfterCommit?: DeferredAfterCommit
  }
): Promise<number> {
  const rows = await opts.db.select({
    eventId: pendingStripeEvents.eventId,
    payload: pendingStripeEvents.payload
  })
    .from(pendingStripeEvents)
    .where(and(
      eq(pendingStripeEvents.customerId, customerId),
      eq(pendingStripeEvents.processed, false)
    ))
    .orderBy(pendingStripeEvents.receivedAt)

  for (const row of rows) {
    try {
      await runHandler(row.payload as Stripe.Event, opts)
      await opts.db.update(pendingStripeEvents)
        .set({ processed: true, processedAt: new Date() })
        .where(eq(pendingStripeEvents.eventId, row.eventId))
      console.log(`[stripe/webhook] drained stashed event ${row.eventId} for customer ${customerId}`)
    } catch (e) {
      // Don't propagate — one bad stashed event shouldn't block the
      // rest from replaying. Sentry capture so ops sees it; the row
      // stays processed=false and the daily sweep eventually reaps it.
      console.warn(`[stripe/webhook] drain failed for stashed event ${row.eventId}:`, e instanceof Error ? e.message : e)
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
 * we short-circuit — Stripe is satisfied by 200 and stops retrying,
 * but we don't re-apply the event's UPDATEs. This preserves manual
 * ops corrections that landed between the original delivery and a
 * retried redelivery.
 *
 * Out-of-order stash: subscription.* / invoice.* events that arrive
 * BEFORE checkout.session.completed (i.e. before
 * `users.stripe_customer_id` is set) match zero rows. We stash the
 * full payload in `pending_stripe_events` and drain on the eventual
 * checkout. Defensive belt-and-braces around the live-fetch in
 * `handleCheckoutSessionCompleted` — if anyone removes that
 * subscriptions.retrieve, the stash keeps state convergent.
 *
 * Everything runs in ONE transaction so a crash mid-handler rolls
 * back BOTH the user UPDATE and the dedup INSERT — Stripe's retry
 * then succeeds.
 *
 * `stripe` is the SDK client — only `handleCheckoutSessionCompleted`
 * uses it. Passed explicitly so unit tests can inject a mock.
 */
export async function dispatchStripeEvent(
  event: Stripe.Event,
  opts: {
    stripe: Stripe
    config: { pricePro: string, priceMax: string, priceUltra: string }
  }
): Promise<{ handled: boolean, detail?: unknown, replayed?: boolean, stashed?: boolean }> {
  const db = useDatabase()
  // Phase 7: handlers push LiteLLM key-sync closures here (instead of
  // running them inline) — the surrounding TX holds an exclusive lock
  // on the user row, and `updateUserKeyBudget` opens its own pool
  // connection to UPDATE the same row. We flush these AFTER the TX
  // commits so the lock has been released.
  const deferAfterCommit: DeferredAfterCommit = []
  const result = await db.transaction(async (tx: DbOrTx) => {
    // Step 1: dedup. Atomic INSERT with ON CONFLICT DO NOTHING; if
    // the returning array is empty, this event.id has been processed
    // before. Short-circuit so the row stays at whatever state it's
    // in (including any out-of-band ops correction).
    const inserted = await tx.insert(processedWebhookEvents)
      .values({ eventId: event.id, type: event.type })
      .onConflictDoNothing({ target: processedWebhookEvents.eventId })
      .returning({ eventId: processedWebhookEvents.eventId })

    if (inserted.length === 0) {
      console.log(`[stripe/webhook] replay short-circuited for event ${event.id}`)
      return { handled: true, replayed: true }
    }

    // Step 2: out-of-order stash. For subscription.* / invoice.*
    // events that arrive BEFORE the user is bound to a Stripe
    // customer, store the full payload and bail. The eventual
    // checkout.session.completed drains the stash. The set of
    // order-sensitive types is owned by `shared/contracts/stripe.ts`
    // so the stash matches the dispatcher's switch table.
    if (isOrderSensitiveStripeEvent(event)) {
      const customerId = extractCustomerId(event)
      if (customerId) {
        // Probe: does any user own this customer id? If not, stash.
        const owner = await tx.select({ id: users.id })
          .from(users)
          .where(eq(users.stripeCustomerId, customerId))
          .limit(1)
        if (owner.length === 0) {
          await tx.insert(pendingStripeEvents)
            .values({
              eventId: event.id,
              customerId,
              type: event.type,
              payload: event as unknown as Record<string, unknown>
            })
            .onConflictDoNothing({ target: pendingStripeEvents.eventId })
          console.log(`[stripe/webhook] stashed out-of-order ${event.type} for unbound customer ${customerId} (event ${event.id})`)
          return { handled: true, stashed: true }
        }
      }
    }

    // Step 3: dispatch the event normally.
    const result = await runHandler(event, { ...opts, db: tx, deferAfterCommit })

    // Step 4: if this was a checkout, drain any stashed events that
    // were waiting for this customer to be bound.
    if (event.type === 'checkout.session.completed') {
      const customerId = extractCustomerId(event)
      if (customerId) {
        const drained = await drainPendingEvents(customerId, { ...opts, db: tx, deferAfterCommit })
        if (drained > 0) {
          return { ...result, detail: { ...(result.detail ?? {}), drained } }
        }
      }
    }

    return result
  })

  // Flush deferred LiteLLM key syncs. Each closure already swallows its
  // own errors + reports to Sentry — running them sequentially keeps
  // the side-effect ordering predictable for tests and ops.
  for (const fn of deferAfterCommit) {
    await fn()
  }

  return result
}
