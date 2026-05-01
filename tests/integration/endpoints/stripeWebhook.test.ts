import { describe, it, expect, beforeEach } from 'vitest'
import { nanoid } from 'nanoid'
import { resetDb, testDb } from '../setup/db'
import { TEST_BASE_URL } from '../setup/env'
import { createUser } from '../setup/fixtures'
import {
  loadStripeFixture,
  computeStripeSig,
  makeStripeEvent,
  TEST_WEBHOOK_SECRET
} from '../setup/stripeHelpers'

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
  return r.rows[0]
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
    await testDb().query('UPDATE users SET stripe_customer_id = $1 WHERE id = $2', ['cus_test_alice', u.id])

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

  it('scheduled downgrade (cancel_at_period_end=true): plan stays on Max', async () => {
    const u = await createUser()
    await testDb().query(
      `UPDATE users SET stripe_customer_id = $1, plan = 'max' WHERE id = $2`,
      ['cus_test_alice', u.id]
    )
    const event = loadStripeFixture('customer.subscription.updated-max-scheduled-downgrade')
    await postWebhook(event)
    const row = await readUser(u.id)
    // Plan STAYS on max — user keeps paid tier through period end.
    expect(row.plan).toBe('max')
    // plan_valid_until reflects current_period_end so the resolver
    // (and the plan-lapse sweep) knows when to flip to free.
    expect(row.plan_valid_until!.getTime()).toBe(1778678400 * 1000)
  })

  it('ignores event with an unknown price id (logs + 200)', async () => {
    const u = await createUser()
    await testDb().query('UPDATE users SET stripe_customer_id = $1 WHERE id = $2', ['cus_test_alice', u.id])
    const event = loadStripeFixture('customer.subscription.updated-pro') as Record<string, unknown>
    // Override the price id to something we don't recognise.
    const inner = (event.data as { object: { items: { data: Array<{ price: { id: string } }> } } }).object
    inner.items.data[0].price.id = 'price_test_unknown_tier'
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
    // Simulate active Max subscription.
    await testDb().query(
      `UPDATE users SET stripe_customer_id = $1, stripe_subscription_id = $2,
                        plan = 'max', stripe_current_period_start = now(),
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
      `UPDATE users SET stripe_customer_id = $1, plan = 'pro',
                        stripe_current_period_start = $2, plan_valid_until = $3
       WHERE id = $4`,
      ['cus_test_alice', oldStart, oldEnd, u.id]
    )

    // invoice.paid carries the NEW cycle's period_start/end.
    const event = loadStripeFixture('invoice.paid')
    await postWebhook(event)

    const row = await readUser(u.id)
    // Fixture: period_start = 1778678400 → 2026-05-13 16:00 UTC (the
    // exact timestamp Stripe would report; doesn't matter for the test,
    // only that it landed on the row).
    expect(row.stripe_current_period_start!.getTime()).toBe(1778678400 * 1000)
    expect(row.plan_valid_until!.getTime()).toBe(1781356800 * 1000)
    // Plan stays — invoice.paid doesn't change plan.
    expect(row.plan).toBe('pro')
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
      `UPDATE users SET stripe_customer_id = $1, plan = 'max',
                        plan_valid_until = now() + interval '1 month'
       WHERE id = $2`,
      ['cus_test_alice', u.id]
    )
    const event = loadStripeFixture('invoice.payment_failed')
    const res = await postWebhook(event)
    expect(res.status).toBe(200)
    // Critical: user stays on Max. Stripe will retry; if retries
    // ultimately fail, subscription.deleted fires and THEN we
    // downgrade. Retrying-but-no-downgrade is the user-friendly
    // default — gives them a window to update their card.
    const row = await readUser(u.id)
    expect(row.plan).toBe('max')
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
    await testDb().query('UPDATE users SET stripe_customer_id = $1 WHERE id = $2', ['cus_test_alice', u.id])
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
    expect(row.rows[0].stripe_customer_id).toBeNull()
  })

  it('accepts events with a future timestamp within tolerance (clock skew)', async () => {
    // Small forward clock skew (10s) between Stripe and our server
    // must not reject otherwise-valid signatures. Uses the same
    // tolerance window in the other direction.
    const u = await createUser()
    await testDb().query('UPDATE users SET stripe_customer_id = $1 WHERE id = $2', ['cus_test_alice', u.id])
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
    await testDb().query('UPDATE users SET stripe_customer_id = $1 WHERE id = $2', ['cus_test_alice', u.id])

    // Event A: Pro subscription, period Apr → May.
    const eventA = loadStripeFixture('customer.subscription.updated-pro') as Record<string, unknown>

    // Event B: same user, Max scheduled-downgrade (different plan, different period).
    const eventB = loadStripeFixture('customer.subscription.updated-max-scheduled-downgrade') as Record<string, unknown>

    // Fire both at once.
    const [resA, resB] = await Promise.all([
      postWebhook(eventA),
      postWebhook(eventB)
    ])
    expect(resA.status).toBe(200)
    expect(resB.status).toBe(200)

    // Final state: row holds ONE of the two events' values,
    // consistently. We don't care which order landed (Stripe doesn't
    // either — either is a valid interleaving). We just assert the
    // fields are INTERNALLY consistent: a Pro-matching period with
    // the Pro plan, or Max-matching period with Max plan.
    const r = await testDb().query<{
      plan: string
      stripe_current_period_start: Date
      plan_valid_until: Date
    }>(
      `SELECT plan, stripe_current_period_start, plan_valid_until
       FROM users WHERE id = $1`,
      [u.id]
    )
    const row = r.rows[0]
    // Both fixtures share the same period timestamps (1776000000 → 1778678400)
    // so the period anchors will be identical regardless of order.
    // Plan differs: Event A = pro, Event B = max (Event B has
    // cancel_at_period_end=true → scheduled downgrade, plan stays max).
    expect(['pro', 'max']).toContain(row.plan)
    expect(row.stripe_current_period_start.getTime()).toBe(1776000000 * 1000)
    expect(row.plan_valid_until.getTime()).toBe(1778678400 * 1000)
  })

  it('same event delivered 5x in parallel → idempotent, one consistent state', async () => {
    // Stripe retries on 5xx with exponential backoff. In rare
    // scenarios, retry + new delivery can overlap. Test the
    // extreme case: fire the SAME event 5x concurrently. All
    // should 200; the row should read as if the event applied once.
    const u = await createUser()
    await testDb().query('UPDATE users SET stripe_customer_id = $1 WHERE id = $2', ['cus_test_alice', u.id])
    const event = loadStripeFixture('customer.subscription.updated-pro')
    const results = await Promise.all(
      Array.from({ length: 5 }, () => postWebhook(event))
    )
    for (const res of results) expect(res.status).toBe(200)
    const r = await testDb().query<{ plan: string }>(
      'SELECT plan FROM users WHERE id = $1',
      [u.id]
    )
    expect(r.rows[0].plan).toBe('pro')
    // Exactly one user row (we didn't accidentally create duplicates).
    const c = await testDb().query<{ c: string }>(
      `SELECT COUNT(*) AS c FROM users WHERE stripe_customer_id = 'cus_test_alice'`
    )
    expect(Number(c.rows[0].c)).toBe(1)
  })
})

// -----------------------------------------------------------------------------
// Replay protection — event.id idempotency
// -----------------------------------------------------------------------------
//
// Stripe redelivers webhooks on 5xx with exponential backoff. The retry
// payload carries the SAME `event.id` as the original delivery. A robust
// handler should either (a) record processed event ids in a dedup table
// and short-circuit on replay, or (b) be naïvely idempotent — re-running
// the same UPDATE produces the same row state.
//
// The handlers in `server/utils/stripeWebhook.ts` use option (b): each
// event maps to a single UPDATE with the event's own values. There is
// NO `processed_webhook_events` table. Naïve idempotency is fine for
// replays of the EXACT SAME event — same values land on the same row,
// same final state. It is NOT defensive against:
//
//   1. Replays after concurrent state mutation (e.g. user pauses then
//      cancels — a delayed redelivery of the original "active" event
//      could re-activate a cancelled subscription).
//   2. Replays after a manual ops correction (we set plan='free' for a
//      refund; a stale subscription.updated redelivery flips it back).
//
// 🔴 Finding: no event.id-based dedup. Documented by the test below
// that demonstrates the second-application IS applied (i.e. the handler
// re-runs the UPDATE rather than recognising a replay). See report.
describe('POST /api/webhooks/stripe — event.id replay protection', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('🔴 GAP: replays re-apply the UPDATE (no event.id dedup table)', async () => {
    // EXPECTED behaviour with a `processed_webhook_events` table:
    //   1. First call → event.id inserted, UPDATE applied, plan='pro'.
    //   2. Manual override → plan='free' (simulating ops correction).
    //   3. Replay → handler INSERTs (event.id) ON CONFLICT DO NOTHING,
    //      sees the conflict, short-circuits — plan REMAINS 'free'.
    //
    // ACTUAL behaviour (current handler, no dedup table):
    //   1. First call → UPDATE applied, plan='pro'.
    //   2. Manual override → plan='free'.
    //   3. Replay → UPDATE re-applied, plan FLIPS BACK TO 'pro'.
    //
    // This test asserts the ACTUAL behaviour and adds a comment marking
    // the gap. The user can decide whether to ship a dedup table; if
    // shipped, flip the `expect` below from 'pro' to 'free'.
    const u = await createUser()
    await testDb().query('UPDATE users SET stripe_customer_id = $1 WHERE id = $2', ['cus_test_alice', u.id])
    const event = loadStripeFixture('customer.subscription.updated-pro') as Record<string, unknown>
    // Pin a stable event.id so the dedup test is deterministic.
    event.id = 'evt_replay_test_001'

    const res1 = await postWebhook(event)
    expect(res1.status).toBe(200)
    let row = await readUser(u.id)
    expect(row.plan).toBe('pro')

    // Simulate an out-of-band correction (ops manually flipped plan
    // back). A handler with event.id dedup MUST NOT undo this on
    // replay; a naïvely-idempotent handler WILL.
    await testDb().query('UPDATE users SET plan = $1 WHERE id = $2', ['free', u.id])

    const res2 = await postWebhook(event)
    expect(res2.status).toBe(200)
    row = await readUser(u.id)
    // 🔴 GAP: ACTUAL behaviour — re-applied. If a dedup table is
    // added, this should become `expect(row.plan).toBe('free')`.
    expect(row.plan).toBe('pro')
  })

  it('replays of the SAME event with no concurrent mutation are state-stable', async () => {
    // Sanity check the naïve-idempotency property: re-applying the
    // same event with no intervening writes yields identical state.
    // This is the "good" case the current handler IS robust to —
    // exactly what Stripe-retry-on-5xx normally looks like.
    const u = await createUser()
    await testDb().query('UPDATE users SET stripe_customer_id = $1 WHERE id = $2', ['cus_test_alice', u.id])
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

// -----------------------------------------------------------------------------
// Out-of-order delivery — subscription.updated arriving before checkout
// -----------------------------------------------------------------------------
//
// Stripe's webhook delivery is at-least-once and intentionally NOT
// ordered. A common hazard at signup: `customer.subscription.created`
// or `customer.subscription.updated` can arrive BEFORE
// `checkout.session.completed`, while `users.stripe_customer_id` is
// still null. The subscription handler keys on `stripe_customer_id`,
// so its UPDATE matches zero rows and silently drops.
//
// The handler comment in `stripeWebhook.ts` calls this race out
// explicitly: `handleCheckoutSessionCompleted` synchronously fetches
// the subscription from Stripe and writes everything in ONE row update,
// so the SUBSEQUENT subscription.updated event becomes idempotent.
// But a subscription.updated arriving FIRST has nothing to update.
// Tests below verify the system converges to the correct state once
// the checkout event eventually lands.
describe('POST /api/webhooks/stripe — out-of-order delivery', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('subscription.updated arriving BEFORE checkout: 200 + no-op until checkout binds', async () => {
    // 1. Bare user — no stripe_customer_id yet.
    const u = await createUser()
    let row = await readUser(u.id)
    expect(row.stripe_customer_id).toBeNull()
    expect(row.plan).toBe('free')

    // 2. Stripe delivers subscription.updated FIRST. The handler looks
    //    up by stripe_customer_id, finds nothing, logs, returns 200.
    //    Critically NOT 5xx — Stripe would retry forever, blowing up
    //    the delivery queue.
    const subEvent = loadStripeFixture('customer.subscription.updated-pro') as Record<string, unknown>
    subEvent.id = 'evt_outoforder_sub_001'
    const res1 = await postWebhook(subEvent)
    expect(res1.status).toBe(200)

    // No DB mutation — user row is still bare.
    row = await readUser(u.id)
    expect(row.stripe_customer_id).toBeNull()
    expect(row.plan).toBe('free')

    // 3. checkout.session.completed arrives second. It carries the
    //    customer id binding via `client_reference_id` → user.id, and
    //    the handler synchronously fetches the subscription from
    //    stripe-mock to apply customer + subscription ids in one shot.
    //    (Note: stripe-mock returns a canned price id — see existing
    //    test "stamps customer_id + subscription_id..." for the
    //    rationale; plan stays 'free' here, but customer/sub ids land.)
    const checkoutEvent = loadStripeFixture('checkout.session.completed') as Record<string, unknown>
    ;(checkoutEvent.data as { object: Record<string, unknown> }).object.client_reference_id = String(u.id)
    checkoutEvent.id = 'evt_outoforder_checkout_001'
    const res2 = await postWebhook(checkoutEvent)
    expect(res2.status).toBe(200)

    row = await readUser(u.id)
    expect(row.stripe_customer_id).toBe('cus_test_alice')
    expect(row.stripe_subscription_id).toBe('sub_test_alice_pro')
  })

  it('🔴 GAP: subscription.updated dropped on out-of-order is NOT replayed once binding lands', async () => {
    // Documents the gap: when subscription.updated arrives first and
    // misses (no customer_id binding), there is NO event-stash to replay
    // when checkout.session.completed eventually binds the customer.
    //
    // EXPECTED behaviour with an event-stash queue:
    //   - Initial subscription.updated lands in `pending_webhook_events`.
    //   - checkout.session.completed binds customer + drains queue.
    //   - Plan correctly maps to whichever price the queued event carries.
    //
    // ACTUAL behaviour (current handler, no stash):
    //   - First subscription.updated logs + drops. The handler in
    //     `handleCheckoutSessionCompleted` synchronously fetches the
    //     subscription, so the canonical state is applied via that path
    //     instead. (stripe-mock returns its canned price → plan stays free.)
    //   - In prod, this works because `handleCheckoutSessionCompleted`
    //     reads the subscription LIVE — it doesn't depend on the
    //     missed event. The dropped event is genuinely redundant.
    //
    // Net: no actual data loss in prod, but the test documents the
    // architectural assumption. If the checkout handler stops reading
    // the subscription live, this gap becomes a real bug.
    const u = await createUser()
    const subEvent = loadStripeFixture('customer.subscription.updated-pro') as Record<string, unknown>
    subEvent.id = 'evt_dropped_sub_001'
    const r1 = await postWebhook(subEvent)
    expect(r1.status).toBe(200)

    // No event-stash table exists; the dropped event is gone.
    // (Test passes trivially — there's nothing to assert beyond
    // documenting the gap. The 200 above is the load-bearing claim.)
    let row = await readUser(u.id)
    expect(row.plan).toBe('free')

    const checkoutEvent = loadStripeFixture('checkout.session.completed') as Record<string, unknown>
    ;(checkoutEvent.data as { object: Record<string, unknown> }).object.client_reference_id = String(u.id)
    checkoutEvent.id = 'evt_dropped_checkout_001'
    await postWebhook(checkoutEvent)

    // Customer/sub ids land via the live subscription fetch — the
    // dropped event was redundant in this delivery shape.
    row = await readUser(u.id)
    expect(row.stripe_customer_id).toBe('cus_test_alice')
    expect(row.stripe_subscription_id).toBe('sub_test_alice_pro')
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

// -----------------------------------------------------------------------------
// Body tampering — signature mismatch detection
// -----------------------------------------------------------------------------
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
    await testDb().query('UPDATE users SET stripe_customer_id = $1 WHERE id = $2', ['cus_test_alice', u.id])

    const original = JSON.stringify(loadStripeFixture('customer.subscription.updated-pro'))
    const sig = computeStripeSig(original, TEST_WEBHOOK_SECRET)
    const tampered = original.replace('"plan":"pro"', '"plan":"ultra"')
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

// -----------------------------------------------------------------------------
// Hand-built events — additional edge cases the fixtures don't cover
// -----------------------------------------------------------------------------
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
    // distinctly different namespace (`charge.refunded`) to make sure
    // the dispatch switch's `default` arm is genuinely unconditional.
    const event = makeStripeEvent('charge.refunded', {
      id: 'ch_refund_test',
      object: 'charge',
      amount: 1000,
      refunded: true
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
