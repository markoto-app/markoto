import { describe, it, expect, beforeEach } from 'vitest'
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
