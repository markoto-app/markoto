import { describe, it, expect, beforeEach } from 'vitest'
import { nanoid } from 'nanoid'
import { resetDb, testDb } from '../setup/db'
import { TEST_BASE_URL } from '../setup/env'
import { createUser, createWorkspace } from '../setup/fixtures'
import {
  loadStripeFixture,
  computeStripeSig,
  makeStripeEvent,
  TEST_WEBHOOK_SECRET
} from '../setup/stripeHelpers'
import { first } from '../../helpers/assert'

// Webhook handler integration tests. Each test:
//   1. Constructs an event (from a committed fixture or makeStripeEvent)
//   2. Signs it with the test webhook secret (same one Nuxt is booted with)
//   3. POSTs to /api/webhooks/stripe with the signature header
//   4. Asserts the DB mutation landed
//
// Uses raw `fetch` instead of the TestClient helper because the
// webhook endpoint has no cookies; just a signature header + body.

async function readUser(id: number): Promise<{
  plan: string
  stripe_customer_id: string | null
  stripe_subscription_id: string | null
  stripe_current_period_start: Date | null
  plan_valid_until: Date | null
}> {
  const r = await testDb().query<{
    plan: string
    stripe_customer_id: string | null
    stripe_subscription_id: string | null
    stripe_current_period_start: Date | null
    plan_valid_until: Date | null
  }>(
    `SELECT plan, stripe_customer_id, stripe_subscription_id,
            stripe_current_period_start, plan_valid_until
     FROM users WHERE id = $1`,
    [id]
  )
  return first(r.rows, 'users row')
}

async function postWebhook(payload: unknown, opts?: { badSig?: boolean, skew?: number }): Promise<Response> {
  const body = JSON.stringify(payload)
  const sig = opts?.badSig
    ? 't=0,v1=deadbeef'
    : computeStripeSig(body, TEST_WEBHOOK_SECRET, opts?.skew ? Math.floor(Date.now() / 1000) + opts.skew : undefined)
  return fetch(`${TEST_BASE_URL}/api/webhooks/stripe`, {
    method: 'POST',
    headers: { 'stripe-signature': sig, 'content-type': 'application/json' },
    body
  })
}

describe('POST /api/webhooks/stripe — signature verification', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('400 on missing signature header', async () => {
    const res = await fetch(`${TEST_BASE_URL}/api/webhooks/stripe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ foo: 'bar' })
    })
    expect(res.status).toBe(400)
  })

  it('400 on invalid signature', async () => {
    const event = loadStripeFixture('checkout.session.completed')
    const res = await postWebhook(event, { badSig: true })
    expect(res.status).toBe(400)
  })

  it('200 on valid signature + known event type', async () => {
    const u = await createUser()
    const event = loadStripeFixture('checkout.session.completed') as Record<string, unknown>
    // Stamp the real user id so the client_reference_id matches.
    ;(event.data as { object: Record<string, unknown> }).object.client_reference_id = String(u.id)
    const res = await postWebhook(event)
    expect(res.status).toBe(200)
  })
})

describe('POST /api/webhooks/stripe — checkout.session.completed', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('stamps customer_id + subscription_id AND fetches subscription from Stripe (race fix)', async () => {
    // Race-fix: checkout.session.completed handler fetches the
    // subscription from Stripe synchronously and applies customer +
    // subscription ids + period anchors in one DB write. This
    // closes the bug where a subscription.updated arriving FIRST
    // would silently miss (user row has no stripe_customer_id yet).
    //
    // Period anchors land because stripe-mock returns them on the
    // subscription item. Plan stays 'free' in THIS test because
    // stripe-mock's retrieve returns its own canned price id (not
    // one of our configured ones). The plan-mapping branch is
    // exercised separately by the subscription.updated tests below
    // (which send a signed event with OUR price ids) and by the
    // unit tests that mock the Stripe SDK.
    const u = await createUser()
    const event = loadStripeFixture('checkout.session.completed') as Record<string, unknown>
    ;(event.data as { object: Record<string, unknown> }).object.client_reference_id = String(u.id)
    await postWebhook(event)
    const row = await readUser(u.id)
    expect(row.stripe_customer_id).toBe('cus_test_alice')
    expect(row.stripe_subscription_id).toBe('sub_test_alice_pro')
    expect(row.stripe_current_period_start).not.toBeNull()
    expect(row.plan_valid_until).not.toBeNull()
  })

  it('200 + no-op when client_reference_id is missing', async () => {
    const event = loadStripeFixture('checkout.session.completed') as Record<string, unknown>
    ;(event.data as { object: Record<string, unknown> }).object.client_reference_id = null
    const res = await postWebhook(event)
    expect(res.status).toBe(200) // still 200; orphan checkout is logged not fatal
  })
})

describe('POST /api/webhooks/stripe — customer.subscription.updated', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('sets plan + period anchors on a Pro subscription', async () => {
    const u = await createUser()
    // Pre-stamp customer id so the handler can find the user.
    await testDb().query('UPDATE users SET stripe_customer_id = $1, stripe_subscription_id = $2 WHERE id = $3', ['cus_test_alice', 'sub_test_alice_pro', u.id])

    const event = loadStripeFixture('customer.subscription.updated-pro')
    const res = await postWebhook(event)
    expect(res.status).toBe(200)

    const row = await readUser(u.id)
    expect(row.plan).toBe('pro')
    expect(row.stripe_subscription_id).toBe('sub_test_alice_pro')
    // period_start = 1776000000 → that's ~2026-04-12. Verify it
    // landed as a real Date, not null.
    expect(row.stripe_current_period_start).not.toBeNull()
    expect(row.stripe_current_period_start!.getTime()).toBe(1776000000 * 1000)
    expect(row.plan_valid_until!.getTime()).toBe(1778678400 * 1000)
  })

  it('scheduled downgrade (cancel_at_period_end=true): plan stays on Pro', async () => {
    const u = await createUser()
    await testDb().query(
      `UPDATE users SET stripe_customer_id = $1, stripe_subscription_id = $2, plan = 'pro' WHERE id = $3`,
      ['cus_test_alice', 'sub_test_alice_max', u.id]
    )
    const event = loadStripeFixture('customer.subscription.updated-pro-scheduled-downgrade')
    await postWebhook(event)
    const row = await readUser(u.id)
    // Plan STAYS on pro — user keeps paid tier through period end.
    expect(row.plan).toBe('pro')
    // plan_valid_until reflects current_period_end so the resolver
    // (and the plan-lapse sweep) knows when to flip to free.
    expect(row.plan_valid_until!.getTime()).toBe(1778678400 * 1000)
  })

  it('ignores event with an unknown price id (logs + 200)', async () => {
    const u = await createUser()
    await testDb().query('UPDATE users SET stripe_customer_id = $1, stripe_subscription_id = $2 WHERE id = $3', ['cus_test_alice', 'sub_test_alice_pro', u.id])
    const event = loadStripeFixture('customer.subscription.updated-pro') as Record<string, unknown>
    // Override the price id to something we don't recognise.
    const inner = (event.data as { object: { items: { data: Array<{ price: { id: string } }> } } }).object
    first(inner.items.data).price.id = 'price_test_unknown_tier'
    const res = await postWebhook(event)
    expect(res.status).toBe(200) // graceful
    const row = await readUser(u.id)
    expect(row.plan).toBe('free') // unchanged
  })
})

describe('POST /api/webhooks/stripe — customer.subscription.deleted', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('reverts plan to free and nulls the stripe anchor', async () => {
    const u = await createUser()
    // Simulate active Pro subscription.
    await testDb().query(
      `UPDATE users SET stripe_customer_id = $1, stripe_subscription_id = $2,
                        plan = 'pro', stripe_current_period_start = now(),
                        plan_valid_until = now() + interval '1 month'
       WHERE id = $3`,
      ['cus_test_alice', 'sub_test_alice_pro', u.id]
    )

    const event = loadStripeFixture('customer.subscription.deleted')
    await postWebhook(event)

    const row = await readUser(u.id)
    expect(row.plan).toBe('free')
    expect(row.stripe_subscription_id).toBeNull()
    expect(row.stripe_current_period_start).toBeNull()
    expect(row.plan_valid_until).toBeNull()
    // Customer id RETAINED — user may resubscribe later, we can re-use it.
    expect(row.stripe_customer_id).toBe('cus_test_alice')
  })

  it('a late subscription.updated after the deletion does not bring Pro back', async () => {
    const u = await createUser()
    await testDb().query(
      `UPDATE users SET stripe_customer_id = $1, stripe_subscription_id = $2, plan = 'pro' WHERE id = $3`,
      ['cus_test_alice', 'sub_test_alice_pro', u.id]
    )
    await postWebhook(loadStripeFixture('customer.subscription.deleted'))
    // Stripe retries an older `updated` (status active) of the same subscription.
    const late = loadStripeFixture('customer.subscription.updated-pro') as Record<string, unknown>
    late.id = 'evt_test_late_update'
    expect((await postWebhook(late)).status).toBe(200)
    const row = await readUser(u.id)
    expect(row.plan).toBe('free')
    expect(row.stripe_subscription_id).toBeNull()
  })
})

describe('POST /api/webhooks/stripe — invoice.paid', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('advances period anchors on subscription renewal', async () => {
    const u = await createUser()
    // Existing Pro sub; old period Apr 15 → May 15.
    const oldStart = new Date('2026-04-15T00:00:00Z')
    const oldEnd = new Date('2026-05-15T00:00:00Z')
    await testDb().query(
      `UPDATE users SET stripe_customer_id = $1, stripe_subscription_id = $2, plan = 'pro',
                        stripe_current_period_start = $3, plan_valid_until = $4
       WHERE id = $5`,
      ['cus_test_alice', 'sub_test_alice_pro', oldStart, oldEnd, u.id]
    )

    // The fixture has the pinned API version's shape (2025-01-27.acacia:
    // `invoice.subscription` on the root). The NEW cycle is the line
    // item's period; the invoice's own period_start/_end is the cycle
    // that just ended and must not be used.
    const event = loadStripeFixture('invoice.paid')
    await postWebhook(event)

    const row = await readUser(u.id)
    expect(row.stripe_current_period_start!.getTime()).toBe(1778678400 * 1000)
    expect(row.plan_valid_until!.getTime()).toBe(1781356800 * 1000)
    // Plan stays — invoice.paid doesn't change plan.
    expect(row.plan).toBe('pro')
  })

  it('reads the subscription from `parent` too (newer API versions)', async () => {
    const u = await createUser()
    await testDb().query(
      `UPDATE users SET stripe_customer_id = $1, stripe_subscription_id = $2, plan = 'pro' WHERE id = $3`,
      ['cus_test_alice', 'sub_test_alice_pro', u.id]
    )
    const event = loadStripeFixture('invoice.paid') as Record<string, unknown>
    const obj = (event.data as { object: Record<string, unknown> }).object
    delete obj.subscription
    obj.parent = { type: 'subscription_details', subscription_details: { subscription: 'sub_test_alice_pro' } }
    await postWebhook(event)
    expect((await readUser(u.id)).plan_valid_until!.getTime()).toBe(1781356800 * 1000)
  })

  it('never moves the period back (a late invoice of an older cycle)', async () => {
    const u = await createUser()
    const later = new Date('2026-07-13T00:00:00Z')
    await testDb().query(
      `UPDATE users SET stripe_customer_id = $1, stripe_subscription_id = $2, plan = 'pro', plan_valid_until = $3 WHERE id = $4`,
      ['cus_test_alice', 'sub_test_alice_pro', later, u.id]
    )
    await postWebhook(loadStripeFixture('invoice.paid'))
    expect((await readUser(u.id)).plan_valid_until!.getTime()).toBe(later.getTime())
  })

  it('ignores an invoice of a subscription the user no longer has', async () => {
    const u = await createUser()
    await testDb().query(
      `UPDATE users SET stripe_customer_id = $1, stripe_subscription_id = NULL, plan = 'free' WHERE id = $2`,
      ['cus_test_alice', u.id]
    )
    await postWebhook(loadStripeFixture('invoice.paid'))
    expect((await readUser(u.id)).plan_valid_until).toBeNull()
  })

  it('ignores non-subscription invoices', async () => {
    const u = await createUser()
    await testDb().query(
      `UPDATE users SET stripe_customer_id = $1, plan = 'pro' WHERE id = $2`,
      ['cus_test_alice', u.id]
    )
    // Strip the subscription pointer so this looks like a one-off charge.
    // Stripe API 2025+ moved this onto `parent.subscription_details`, but
    // the legacy `subscription` root field is still present for older
    // accounts — null both so the handler treats this as a one-off
    // regardless of which API version the row was minted under.
    const event = loadStripeFixture('invoice.paid') as Record<string, unknown>
    const obj = (event.data as { object: Record<string, unknown> }).object
    obj.subscription = null
    obj.parent = null
    const res = await postWebhook(event)
    expect(res.status).toBe(200)
    // User row unchanged — no period shift.
    const row = await readUser(u.id)
    expect(row.stripe_current_period_start).toBeNull()
  })
})

describe('POST /api/webhooks/stripe — invoice.payment_failed', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('does NOT downgrade on first payment failure (Stripe retries)', async () => {
    const u = await createUser()
    await testDb().query(
      `UPDATE users SET stripe_customer_id = $1, plan = 'pro',
                        plan_valid_until = now() + interval '1 month'
       WHERE id = $2`,
      ['cus_test_alice', u.id]
    )
    const event = loadStripeFixture('invoice.payment_failed')
    const res = await postWebhook(event)
    expect(res.status).toBe(200)
    // Critical: user stays on Pro. Stripe will retry; if retries
    // ultimately fail, subscription.deleted fires and THEN we
    // downgrade. Retrying-but-no-downgrade is the user-friendly
    // default — gives them a window to update their card.
    const row = await readUser(u.id)
    expect(row.plan).toBe('pro')
    expect(row.plan_valid_until).not.toBeNull()
  })
})

describe('POST /api/webhooks/stripe — idempotency', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('replaying the same event twice results in the same state (no double-application)', async () => {
    // Stripe retries webhooks on 5xx. Our handlers must be idempotent:
    // applying the same event twice produces the same final state.
    const u = await createUser()
    await testDb().query('UPDATE users SET stripe_customer_id = $1, stripe_subscription_id = $2 WHERE id = $3', ['cus_test_alice', 'sub_test_alice_pro', u.id])
    const event = loadStripeFixture('customer.subscription.updated-pro')

    await postWebhook(event)
    const first = await readUser(u.id)

    await postWebhook(event)
    const second = await readUser(u.id)

    // Every field identical — the second apply was a no-op-equivalent
    // update (same values).
    expect(second.plan).toBe(first.plan)
    expect(second.stripe_current_period_start!.getTime()).toBe(first.stripe_current_period_start!.getTime())
    expect(second.plan_valid_until!.getTime()).toBe(first.plan_valid_until!.getTime())
    expect(second.stripe_subscription_id).toBe(first.stripe_subscription_id)
  })
})

describe('POST /api/webhooks/stripe — unknown event types', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('200s (acknowledges, does nothing) on events we don\'t handle', async () => {
    // Stripe sends dozens of event types — we only subscribe to a few.
    // The rest should 200 so Stripe stops retrying, not 500.
    const event = makeStripeEvent('customer.updated', {
      id: 'cus_test_alice',
      object: 'customer'
    })
    const res = await postWebhook(event)
    expect(res.status).toBe(200)
  })
})

describe('POST /api/webhooks/stripe — replay protection', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('rejects events with a stale timestamp (Stripe SDK tolerance)', async () => {
    // Stripe's signature format includes a timestamp (`t=N`). The SDK's
    // `constructEvent` validates `now - t < tolerance` (default 300s)
    // to block replay attacks where an attacker captures a signed
    // payload and resends it later. We feed `computeStripeSig` a
    // timestamp from an hour ago; signature is cryptographically
    // valid but the SDK should reject on staleness alone.
    const u = await createUser()
    const event = loadStripeFixture('checkout.session.completed') as Record<string, unknown>
    ;(event.data as { object: Record<string, unknown> }).object.client_reference_id = String(u.id)
    const res = await postWebhook(event, { skew: -3600 }) // 1 hour old
    expect(res.status).toBe(400)
    // User row unchanged — nothing should have been applied.
    const row = await testDb().query<{ stripe_customer_id: string | null }>(
      'SELECT stripe_customer_id FROM users WHERE id = $1',
      [u.id]
    )
    expect(first(row.rows).stripe_customer_id).toBeNull()
  })

  it('accepts events with a future timestamp within tolerance (clock skew)', async () => {
    // Small forward clock skew (10s) between Stripe and our server
    // must not reject otherwise-valid signatures. Uses the same
    // tolerance window in the other direction.
    const u = await createUser()
    await testDb().query('UPDATE users SET stripe_customer_id = $1, stripe_subscription_id = $2 WHERE id = $3', ['cus_test_alice', 'sub_test_alice_pro', u.id])
    const event = loadStripeFixture('customer.subscription.updated-pro')
    const res = await postWebhook(event, { skew: 10 })
    expect(res.status).toBe(200)
  })
})

describe('POST /api/webhooks/stripe — concurrent delivery', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('two simultaneous subscription.updated events for the same user produce a consistent final row', async () => {
    // Stripe's webhook delivery is at-least-once and intentionally
    // NOT ordered — two events fired within a second of each other
    // can arrive in either order. Our handler uses a single UPDATE
    // per event, so Postgres serialises them on the row lock. Final
    // state = whichever event's values won the last write. This
    // test fires both requests in parallel and asserts the final
    // row matches ONE of the events (not a corrupted blend).
    const u = await createUser()
    await testDb().query('UPDATE users SET stripe_customer_id = $1, stripe_subscription_id = $2 WHERE id = $3', ['cus_test_alice', 'sub_test_alice_pro', u.id])

    // Event A: Pro subscription, period Apr → May.
    const eventA = loadStripeFixture('customer.subscription.updated-pro') as Record<string, unknown>

    // Event B: same user, Pro scheduled-downgrade (different period handling).
    const eventB = loadStripeFixture('customer.subscription.updated-pro-scheduled-downgrade') as Record<string, unknown>

    // Fire both at once.
    const [resA, resB] = await Promise.all([
      postWebhook(eventA),
      postWebhook(eventB)
    ])
    expect(resA.status).toBe(200)
    expect(resB.status).toBe(200)

    // Final state: the row holds the values of whichever event landed last. Both events are Pro with identical
    // period timestamps, so the result is the same in either order; a corrupted blend would show up as a mismatch.
    const r = await testDb().query<{
      plan: string
      stripe_current_period_start: Date
      plan_valid_until: Date
    }>(
      `SELECT plan, stripe_current_period_start, plan_valid_until
       FROM users WHERE id = $1`,
      [u.id]
    )
    const row = first(r.rows)
    // Both fixtures share the same period timestamps (1776000000 → 1778678400)
    // so the period anchors will be identical regardless of order.
    // Both events are Pro (Event B has cancel_at_period_end=true →
    // scheduled downgrade, plan stays pro).
    expect(row.plan).toBe('pro')
    expect(row.stripe_current_period_start.getTime()).toBe(1776000000 * 1000)
    expect(row.plan_valid_until.getTime()).toBe(1778678400 * 1000)
  })

  it('same event delivered 5x in parallel → idempotent, one consistent state', async () => {
    // Stripe retries on 5xx with exponential backoff. In rare
    // scenarios, retry + new delivery can overlap. Test the
    // extreme case: fire the SAME event 5x concurrently. All
    // should 200; the row should read as if the event applied once.
    const u = await createUser()
    await testDb().query('UPDATE users SET stripe_customer_id = $1, stripe_subscription_id = $2 WHERE id = $3', ['cus_test_alice', 'sub_test_alice_pro', u.id])
    const event = loadStripeFixture('customer.subscription.updated-pro')
    const results = await Promise.all(
      Array.from({ length: 5 }, () => postWebhook(event))
    )
    for (const res of results) expect(res.status).toBe(200)
    const r = await testDb().query<{ plan: string }>(
      'SELECT plan FROM users WHERE id = $1',
      [u.id]
    )
    expect(first(r.rows).plan).toBe('pro')
    // Exactly one user row (we didn't accidentally create duplicates).
    const c = await testDb().query<{ c: string }>(
      `SELECT COUNT(*) AS c FROM users WHERE stripe_customer_id = 'cus_test_alice'`
    )
    expect(Number(first(c.rows).c)).toBe(1)
  })
})

// Replay protection — event.id idempotency
//
// Stripe redelivers webhooks on 5xx with exponential backoff. The retry
// payload carries the SAME `event.id` as the original delivery. We INSERT
// each `event.id` into `processed_webhook_events` inside the same
// transaction as the user UPDATE; on conflict the handler short-circuits
// with `200 + replayed:true` and the existing row state is preserved.
//
// This protects against two replay hazards naïve UPSERT idempotency
// can't:
//
//   1. Replays after concurrent state mutation (e.g. user pauses then
//      cancels — a delayed redelivery of the original "active" event
//      would re-activate a cancelled subscription).
//   2. Replays after a manual ops correction (e.g. plan flipped to
//      'free' for a refund — a stale subscription.updated redelivery
//      would flip it back).
//
// The dedup table is in the same transaction as the user UPDATE, so
// a handler crash rolls both back and Stripe's retry succeeds.
describe('POST /api/webhooks/stripe — event.id replay protection', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('preserves manual ops corrections via event.id dedup', async () => {
    // First call → event.id inserted into processed_webhook_events,
    // UPDATE applied, plan='pro'.
    // Manual override → plan='free' (simulating ops correction, e.g.
    // refund handled out-of-band).
    // Replay → handler INSERTs (event.id) ON CONFLICT DO NOTHING,
    // sees the conflict, short-circuits — the manual correction
    // (plan='free') is preserved.
    const u = await createUser()
    await testDb().query('UPDATE users SET stripe_customer_id = $1, stripe_subscription_id = $2 WHERE id = $3', ['cus_test_alice', 'sub_test_alice_pro', u.id])
    const event = loadStripeFixture('customer.subscription.updated-pro') as Record<string, unknown>
    // Pin a stable event.id so the dedup test is deterministic.
    event.id = 'evt_replay_test_001'

    const res1 = await postWebhook(event)
    expect(res1.status).toBe(200)
    const body1 = await res1.json()
    // First delivery: not a replay.
    expect(body1.replayed).toBeUndefined()
    let row = await readUser(u.id)
    expect(row.plan).toBe('pro')

    // Simulate an out-of-band correction (ops manually flipped plan
    // back). With event.id dedup, the replay below MUST NOT undo this.
    await testDb().query('UPDATE users SET plan = $1 WHERE id = $2', ['free', u.id])

    const res2 = await postWebhook(event)
    expect(res2.status).toBe(200)
    const body2 = await res2.json()
    // Explicit dedup marker — proves the short-circuit fired.
    expect(body2.replayed).toBe(true)
    row = await readUser(u.id)
    // Manual correction preserved — the replay did NOT clobber 'free'
    // back to 'pro'.
    expect(row.plan).toBe('free')

    // Belt-and-braces: the dedup table holds exactly one row for this
    // event.id even after the replay attempt.
    const dedupRows = await testDb().query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM processed_webhook_events WHERE event_id = $1`,
      ['evt_replay_test_001']
    )
    expect(Number(first(dedupRows.rows).count)).toBe(1)
  })

  it('replays of the SAME event with no concurrent mutation are state-stable', async () => {
    // Sanity check the naïve-idempotency property: re-applying the
    // same event with no intervening writes yields identical state.
    // This is the "good" case the current handler IS robust to —
    // exactly what Stripe-retry-on-5xx normally looks like.
    const u = await createUser()
    await testDb().query('UPDATE users SET stripe_customer_id = $1, stripe_subscription_id = $2 WHERE id = $3', ['cus_test_alice', 'sub_test_alice_pro', u.id])
    const event = loadStripeFixture('customer.subscription.updated-pro') as Record<string, unknown>
    event.id = 'evt_replay_sanity_001'

    await postWebhook(event)
    const first = await readUser(u.id)
    await postWebhook(event)
    const second = await readUser(u.id)

    expect(second.plan).toBe(first.plan)
    expect(second.stripe_subscription_id).toBe(first.stripe_subscription_id)
    expect(second.stripe_current_period_start!.getTime())
      .toBe(first.stripe_current_period_start!.getTime())
    expect(second.plan_valid_until!.getTime())
      .toBe(first.plan_valid_until!.getTime())
  })
})

// Out-of-order delivery — subscription.updated arriving before checkout
//
// Stripe's webhook delivery is at-least-once and intentionally NOT
// ordered. A common hazard at signup: `customer.subscription.created`
// or `customer.subscription.updated` can arrive BEFORE
// `checkout.session.completed`, while `users.stripe_customer_id` is
// still null. The subscription handler keys on `stripe_customer_id`,
// so its UPDATE matches zero rows and silently drops.
//
// We stash unmatched subscription/invoice events in
// `pending_stripe_events` keyed by customer id; on
// `checkout.session.completed` (after the customer id is bound) we
// drain matching rows in `received_at` order and replay them in the
// same transaction as the checkout. This makes the system robust
// even if `handleCheckoutSessionCompleted` ever stops doing the live
// `stripe.subscriptions.retrieve` it currently relies on.
describe('POST /api/webhooks/stripe — out-of-order delivery', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('subscription.updated arriving BEFORE checkout: 200 + stashed; checkout drains the stash', async () => {
    // 1. Bare user — no stripe_customer_id yet.
    const u = await createUser()
    let row = await readUser(u.id)
    expect(row.stripe_customer_id).toBeNull()
    expect(row.plan).toBe('free')

    // 2. Stripe delivers subscription.updated FIRST. The handler looks
    //    up by stripe_customer_id, finds nothing, STASHES the event
    //    payload in pending_stripe_events keyed by the customer id,
    //    and returns 200 with `stashed: true`.
    const subEvent = loadStripeFixture('customer.subscription.updated-pro') as Record<string, unknown>
    subEvent.id = 'evt_outoforder_sub_001'
    const res1 = await postWebhook(subEvent)
    expect(res1.status).toBe(200)
    const body1 = await res1.json()
    expect(body1.stashed).toBe(true)

    // No DB mutation on the user row — still bare.
    row = await readUser(u.id)
    expect(row.stripe_customer_id).toBeNull()
    expect(row.plan).toBe('free')

    // The event landed in the stash table.
    const stashRows = await testDb().query<{
      event_id: string
      customer_id: string
      type: string
      processed: boolean
    }>(
      `SELECT event_id, customer_id, type, processed
       FROM pending_stripe_events WHERE event_id = $1`,
      ['evt_outoforder_sub_001']
    )
    expect(stashRows.rows).toHaveLength(1)
    expect(first(stashRows.rows).customer_id).toBe('cus_test_alice')
    expect(first(stashRows.rows).processed).toBe(false)

    // 3. checkout.session.completed arrives second. It binds the
    //    customer id to the user row via the live subscription fetch,
    //    THEN drains the stashed event by replaying it through the
    //    dispatcher inside the same transaction. The replay applies
    //    plan='pro' from the stashed payload (which carries our
    //    real `price_test_pro`, unlike the canned price stripe-mock
    //    returns from `subscriptions.retrieve`).
    const checkoutEvent = loadStripeFixture('checkout.session.completed') as Record<string, unknown>
    ;(checkoutEvent.data as { object: Record<string, unknown> }).object.client_reference_id = String(u.id)
    checkoutEvent.id = 'evt_outoforder_checkout_001'
    const res2 = await postWebhook(checkoutEvent)
    expect(res2.status).toBe(200)

    row = await readUser(u.id)
    expect(row.stripe_customer_id).toBe('cus_test_alice')
    expect(row.stripe_subscription_id).toBe('sub_test_alice_pro')
    // Stashed event was replayed → plan flipped from 'free' to 'pro'
    // using the price id from the original out-of-order payload.
    expect(row.plan).toBe('pro')

    // The stash row is now flipped to processed=true (kept for a week
    // for ops audit; the daily sweep prunes after that).
    const drained = await testDb().query<{
      processed: boolean
      processed_at: Date | null
    }>(
      `SELECT processed, processed_at
       FROM pending_stripe_events WHERE event_id = $1`,
      ['evt_outoforder_sub_001']
    )
    expect(first(drained.rows).processed).toBe(true)
    expect(first(drained.rows).processed_at).not.toBeNull()
  })

  it('stashed subscription.updated is replayed and reflects in final user state', async () => {
    // Tighter version of the above: explicitly assert that the stashed
    // event's PRICE id (price_test_pro) wins over the canned price
    // returned by stripe-mock's `subscriptions.retrieve`. This proves
    // the drain happens AFTER the checkout's UPDATE, so the stashed
    // event's later-applied UPDATE overrides any earlier write — the
    // ordering required by the "received_at ASC" drain semantics.
    const u = await createUser()
    const subEvent = loadStripeFixture('customer.subscription.updated-pro') as Record<string, unknown>
    subEvent.id = 'evt_dropped_sub_001'
    const r1 = await postWebhook(subEvent)
    expect(r1.status).toBe(200)
    const body1 = await r1.json()
    expect(body1.stashed).toBe(true)

    // User still bare — only the stash table got the data.
    let row = await readUser(u.id)
    expect(row.plan).toBe('free')

    const checkoutEvent = loadStripeFixture('checkout.session.completed') as Record<string, unknown>
    ;(checkoutEvent.data as { object: Record<string, unknown> }).object.client_reference_id = String(u.id)
    checkoutEvent.id = 'evt_dropped_checkout_001'
    await postWebhook(checkoutEvent)

    row = await readUser(u.id)
    // Customer/sub ids landed during checkout's live fetch.
    expect(row.stripe_customer_id).toBe('cus_test_alice')
    expect(row.stripe_subscription_id).toBe('sub_test_alice_pro')
    // Plan='pro' came from the stash drain (replay of the original
    // subscription.updated payload), not from the live fetch.
    expect(row.plan).toBe('pro')
  })

  it('subscription.deleted arriving BEFORE customer is known: 200 + no-op (no row matches)', async () => {
    // Edge case: cancellation event for a customer we've never bound.
    // This shouldn't happen in practice (we'd have to MISS the
    // checkout.session AND every subscription.created/updated, then
    // observe the deletion) — but the handler must still 200 so Stripe
    // stops retrying.
    const u = await createUser()
    const event = loadStripeFixture('customer.subscription.deleted') as Record<string, unknown>
    event.id = 'evt_outoforder_delete_001'
    const res = await postWebhook(event)
    expect(res.status).toBe(200) // critical — never 500 on no-row-match
    const row = await readUser(u.id)
    expect(row.plan).toBe('free') // unchanged
    expect(row.stripe_customer_id).toBeNull()
  })
})

// Body tampering — signature mismatch detection
//
// Stripe's signature is computed over the EXACT raw body. Any byte
// modification post-signing — even reordering whitespace — breaks
// verification. Stripe's SDK rejects with "No signatures found matching
// the expected signature for payload" and the handler returns 400.
describe('POST /api/webhooks/stripe — body tampering', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('400 when body is modified post-signature (signature mismatch)', async () => {
    // Sign the original, then ship a tampered body with the original
    // signature. Mirrors a MITM rewriting `customer` to point at a
    // different user's id mid-flight.
    const original = JSON.stringify(loadStripeFixture('customer.subscription.updated-pro'))
    const sig = computeStripeSig(original, TEST_WEBHOOK_SECRET)

    // Swap the customer id mid-flight — signature was computed over
    // 'cus_test_alice', body now claims 'cus_test_attacker'.
    const tampered = original.replace('cus_test_alice', 'cus_test_attacker')
    expect(tampered).not.toBe(original) // sanity — replacement actually happened

    const res = await fetch(`${TEST_BASE_URL}/api/webhooks/stripe`, {
      method: 'POST',
      headers: { 'stripe-signature': sig, 'content-type': 'application/json' },
      body: tampered
    })
    expect(res.status).toBe(400)
  })

  it('400 when only whitespace differs from the signed body', async () => {
    // Stricter variant: same JSON semantics, different bytes. Stripe's
    // verifier is byte-exact. This catches accidental re-stringification
    // somewhere in our middleware (we use readRawBody — but a future
    // refactor that re-emits JSON would silently break verification on
    // a small fraction of requests).
    const original = JSON.stringify(loadStripeFixture('customer.subscription.updated-pro'))
    const sig = computeStripeSig(original, TEST_WEBHOOK_SECRET)
    // Add a single trailing newline.
    const tampered = original + '\n'
    const res = await fetch(`${TEST_BASE_URL}/api/webhooks/stripe`, {
      method: 'POST',
      headers: { 'stripe-signature': sig, 'content-type': 'application/json' },
      body: tampered
    })
    expect(res.status).toBe(400)
  })

  it('no DB writes occur when signature verification fails', async () => {
    // Belt and braces: the handler must abort before the dispatch
    // call, so a tampered body NEVER touches the user row even if
    // the contents would otherwise be applied.
    const u = await createUser()
    await testDb().query('UPDATE users SET stripe_customer_id = $1, stripe_subscription_id = $2 WHERE id = $3', ['cus_test_alice', 'sub_test_alice_pro', u.id])

    const original = JSON.stringify(loadStripeFixture('customer.subscription.updated-pro'))
    const sig = computeStripeSig(original, TEST_WEBHOOK_SECRET)
    const tampered = original.replace('"plan":"pro"', '"plan":"free"')
    // (The replace may be a no-op if the fixture doesn't include the
    // string — that's fine, the test still asserts: bad sig → no write.)
    await fetch(`${TEST_BASE_URL}/api/webhooks/stripe`, {
      method: 'POST',
      headers: { 'stripe-signature': sig, 'content-type': 'application/json' },
      body: tampered.length === original.length ? original + ' ' : tampered
    })
    const row = await readUser(u.id)
    expect(row.plan).toBe('free') // unchanged — handler aborted on sig
  })
})

// Hand-built events — additional edge cases the fixtures don't cover
describe('POST /api/webhooks/stripe — hand-built event edge cases', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('200 on subscription.updated for a customer we have NEVER bound (no row matches)', async () => {
    // Customer id that doesn't exist on any user row. Handler logs +
    // returns 200; never 500 (Stripe would retry forever).
    const event = makeStripeEvent('customer.subscription.updated', {
      id: 'sub_unbound_test',
      object: 'subscription',
      customer: `cus_unbound_${nanoid(8)}`,
      status: 'active',
      cancel_at_period_end: false,
      items: {
        object: 'list',
        data: [{
          id: 'si_unbound',
          object: 'subscription_item',
          current_period_start: 1776000000,
          current_period_end: 1778678400,
          price: { id: 'price_test_pro', object: 'price' }
        }]
      }
    })
    const res = await postWebhook(event)
    expect(res.status).toBe(200)
  })

  it('200 on event types we explicitly do NOT handle (unhandled type)', async () => {
    // Existing test covers `customer.updated`. This one stresses a
    // distinctly different namespace (`radar.early_fraud_warning.created`;
    // `charge.refunded` is handled) to make sure the dispatch
    // switch's `default` arm is genuinely unconditional.
    const event = makeStripeEvent('radar.early_fraud_warning.created', {
      id: 'issfr_test',
      object: 'radar.early_fraud_warning',
      charge: 'ch_refund_test'
    })
    const res = await postWebhook(event)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ received: true, handled: false })
  })

  it('200 on checkout.session.completed with non-numeric client_reference_id (NaN guard)', async () => {
    // The handler does `Number(client_reference_id)` and explicit
    // `Number.isNaN` check. A non-numeric string (e.g. a UUID-like
    // identifier from a buggy frontend) must NOT crash + must NOT
    // accidentally land on user.id=NaN.
    const event = loadStripeFixture('checkout.session.completed') as Record<string, unknown>
    ;(event.data as { object: Record<string, unknown> }).object.client_reference_id = 'not-a-number'
    event.id = 'evt_nan_clientref_001'
    const res = await postWebhook(event)
    expect(res.status).toBe(200) // graceful — orphan-checkout log path
  })

  it('200 + handled=false on hand-built event with unknown api_version (still dispatches by type)', async () => {
    // The dispatcher keys on `event.type` — `api_version` mismatch is
    // not a hard fail. Stripe rolls api versions periodically; older
    // events from before our pin should still flow through.
    const event = makeStripeEvent('customer.created', {
      id: 'cus_created_test',
      object: 'customer'
    }, { id: 'evt_apiver_drift_001' })
    event.api_version = '2020-08-27' // ancient
    const res = await postWebhook(event)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ received: true, handled: false }) // we don't handle customer.created
  })
})

describe('POST /api/webhooks/stripe — workspace subscriptions (Team / Business)', () => {
  beforeEach(async () => {
    await resetDb()
  })

  async function readSub(workspaceId: string): Promise<Record<string, unknown> | undefined> {
    const r = await testDb().query(
      `SELECT plan, seats, status, stripe_subscription_id, currency, interval, valid_until, billing_admin_id
       FROM workspace_subscriptions WHERE workspace_id = $1`,
      [workspaceId]
    )
    return r.rows[0]
  }

  function subscriptionEvent(type: string, customer: string, priceId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return makeStripeEvent(type, {
      id: 'sub_ws_team',
      object: 'subscription',
      customer,
      status: 'active',
      items: {
        data: [{
          id: 'si_ws',
          quantity: 5,
          price: { id: priceId, object: 'price' },
          current_period_start: 1800000000,
          current_period_end: 1802678400
        }]
      },
      ...extra
    })
  }

  async function seedWorkspaceCustomer(): Promise<{ adminId: number, workspaceId: string }> {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    await testDb().query(
      `INSERT INTO workspace_subscriptions (workspace_id, plan, seats, status, billing_admin_id, stripe_customer_id, stripe_subscription_id)
       VALUES ($1, 'team', 1, 'incomplete', $2, 'cus_ws_team', 'sub_ws_team')`,
      [ws.workspaceId, admin.id]
    )
    return { adminId: admin.id, workspaceId: ws.workspaceId }
  }

  it('subscription.updated routes a workspace customer to its subscription row (plan, seats, period, price identity)', async () => {
    const { workspaceId, adminId } = await seedWorkspaceCustomer()
    const res = await postWebhook(subscriptionEvent('customer.subscription.updated', 'cus_ws_team', 'price_test_business_year_chf'))
    expect(res.status).toBe(200)
    const row = await readSub(workspaceId)
    expect(row).toMatchObject({
      plan: 'business',
      seats: 5,
      status: 'active',
      currency: 'chf',
      interval: 'year',
      billing_admin_id: adminId
    })
    expect((row?.valid_until as Date).getTime()).toBe(1802678400 * 1000)
    // The admin's personal plan is untouched.
    expect((await readUser(adminId)).plan).toBe('free')
  })

  it('subscription.updated with a Pro price on a workspace customer is ignored', async () => {
    const { workspaceId } = await seedWorkspaceCustomer()
    const res = await postWebhook(subscriptionEvent('customer.subscription.updated', 'cus_ws_team', 'price_test_pro'))
    expect(res.status).toBe(200)
    expect((await readSub(workspaceId))?.status).toBe('incomplete')
  })

  it('subscription.deleted marks the workspace subscription canceled', async () => {
    const { workspaceId } = await seedWorkspaceCustomer()
    await postWebhook(subscriptionEvent('customer.subscription.updated', 'cus_ws_team', 'price_test_team'))
    const res = await postWebhook(makeStripeEvent('customer.subscription.deleted', {
      id: 'sub_ws_team', object: 'subscription', customer: 'cus_ws_team', status: 'canceled'
    }))
    expect(res.status).toBe(200)
    expect((await readSub(workspaceId))?.status).toBe('canceled')
  })

  it('a late subscription.updated after the deletion does not bring the subscription back', async () => {
    const { workspaceId } = await seedWorkspaceCustomer()
    const older = subscriptionEvent('customer.subscription.updated', 'cus_ws_team', 'price_test_team')
    await postWebhook(subscriptionEvent('customer.subscription.updated', 'cus_ws_team', 'price_test_team'))
    await postWebhook(makeStripeEvent('customer.subscription.deleted', {
      id: 'sub_ws_team', object: 'subscription', customer: 'cus_ws_team', status: 'canceled'
    }))
    // Stripe retries an older `updated` (status active) after the deletion.
    expect((await postWebhook(older)).status).toBe(200)
    expect((await readSub(workspaceId))?.status).toBe('canceled')
  })

  it('invoice.paid moves the workspace period to the paid line\'s period', async () => {
    const { workspaceId } = await seedWorkspaceCustomer()
    await postWebhook(subscriptionEvent('customer.subscription.updated', 'cus_ws_team', 'price_test_team'))
    const res = await postWebhook(makeStripeEvent('invoice.paid', {
      id: 'in_ws_renewal',
      object: 'invoice',
      customer: 'cus_ws_team',
      subscription: 'sub_ws_team',
      status: 'paid',
      period_start: 1800000000,
      period_end: 1802678400,
      lines: { object: 'list', has_more: false, data: [{ id: 'il_ws', object: 'line_item', period: { start: 1802678400, end: 1805356800 } }] }
    }))
    expect(res.status).toBe(200)
    expect(((await readSub(workspaceId))?.valid_until as Date).getTime()).toBe(1805356800 * 1000)
  })

  it('events of another subscription never overwrite the live one (duplicate checkout, late events)', async () => {
    const { workspaceId } = await seedWorkspaceCustomer()
    await postWebhook(subscriptionEvent('customer.subscription.updated', 'cus_ws_team', 'price_test_team'))
    expect(await readSub(workspaceId)).toMatchObject({ status: 'active', seats: 5, stripe_subscription_id: 'sub_ws_team' })

    // A second subscription on the same customer (being cancelled as a duplicate).
    const dup = subscriptionEvent('customer.subscription.updated', 'cus_ws_team', 'price_test_business_year_chf')
    ;(dup.data as { object: Record<string, unknown> }).object.id = 'sub_ws_dup'
    expect((await postWebhook(dup)).status).toBe(200)
    expect((await postWebhook(makeStripeEvent('customer.subscription.deleted', {
      id: 'sub_ws_dup', object: 'subscription', customer: 'cus_ws_team', status: 'canceled'
    }))).status).toBe(200)
    expect(await readSub(workspaceId)).toMatchObject({ plan: 'team', status: 'active', seats: 5, stripe_subscription_id: 'sub_ws_team' })
  })

  it('checkout for workspace:<id> whose subscription is not a workspace price writes nothing', async () => {
    // stripe-mock's canned subscription price is annual CHF Pro, so the
    // workspace path must refuse it rather than sell Pro to a workspace.
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    const res = await postWebhook(makeStripeEvent('checkout.session.completed', {
      id: 'cs_ws',
      object: 'checkout.session',
      client_reference_id: `workspace:${ws.workspaceId}`,
      customer: 'cus_ws_new',
      subscription: 'sub_ws_new',
      metadata: { billing_admin_id: String(admin.id) }
    }))
    expect(res.status).toBe(200)
    expect(await readSub(ws.workspaceId)).toBeUndefined()
  })
})
