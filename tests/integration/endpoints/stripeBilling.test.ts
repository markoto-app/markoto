import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, testDb } from '../setup/db'
import { loggedInClient, anonClient } from '../setup/client'
import { createUser } from '../setup/fixtures'

// Integration tests for /api/billing/checkout + /api/billing/portal.
// These hit stripe-mock (docker-compose.test.yml service on :12111)
// which implements Stripe's full REST API surface with fixture
// responses. Our code uses the real Stripe SDK; only the host is
// overridden — the request/response shape contracts are the same as
// against api.stripe.com.

describe('POST /api/billing/checkout', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('401 for anonymous callers', async () => {
    const res = await anonClient().post('/api/billing/checkout', { plan: 'pro' })
    expect(res.status).toBe(401)
  })

  it('400 for invalid plan', async () => {
    const u = await createUser()
    const client = await loggedInClient(u.id)
    for (const bad of [{}, { plan: 'free' }, { plan: 'enterprise' }, { plan: 123 }]) {
      const res = await client.post('/api/billing/checkout', bad)
      expect(res.status).toBe(400)
    }
  })

  it('returns a Checkout URL for a valid pro plan request', async () => {
    const u = await createUser()
    const client = await loggedInClient(u.id)
    const res = await client.post('/api/billing/checkout', { plan: 'pro' })
    expect(res.status).toBe(200)
    const body = await res.json() as { url: string, sessionId: string }
    // stripe-mock returns a deterministic-ish URL; we don't assert
    // the exact host, just that we got a URL and a session id.
    expect(body.url).toMatch(/^https?:\/\//)
    expect(body.sessionId).toMatch(/^cs_/)
  })

  it('refuses Team / Business: those are bought for a workspace', async () => {
    const u = await createUser()
    const client = await loggedInClient(u.id)
    for (const plan of ['team', 'business'] as const) {
      const res = await client.post('/api/billing/checkout', { plan })
      expect(res.status, `plan=${plan}`).toBe(400)
      const body = await res.json() as { data?: { code?: string } }
      expect(body.data?.code, `plan=${plan}`).toBe('billing/workspace-plan')
    }
  })

  it('refuses the retired Max / Ultra plans', async () => {
    const u = await createUser()
    const client = await loggedInClient(u.id)
    for (const plan of ['max', 'ultra']) {
      const res = await client.post('/api/billing/checkout', { plan })
      expect(res.status, `plan=${plan}`).toBe(400)
    }
  })

  it('reuses an existing stripe_customer_id when the user already has one', async () => {
    // User has subscribed before (their stripe_customer_id is set);
    // a new checkout should pass `customer: cus_...` to Stripe rather
    // than creating a fresh customer. We can't directly assert on
    // stripe-mock's request log, but we CAN assert the request
    // succeeds — stripe-mock won't reject the `customer` field if we
    // pass a plausible id.
    const u = await createUser()
    await testDb().query('UPDATE users SET stripe_customer_id = $1 WHERE id = $2', ['cus_existing_test', u.id])
    const client = await loggedInClient(u.id)
    const res = await client.post('/api/billing/checkout', { plan: 'pro' })
    expect(res.status).toBe(200)
  })

  it('swaps IN PLACE when Stripe still has a live subscription for the user', async () => {
    // The double-subscription guard: a user whose row says free but who
    // still has a live Stripe subscription (e.g. a lapse the webhook
    // hasn't caught up with) must get a price swap on that EXISTING
    // subscription, not a Checkout URL (which would create a second
    // concurrent subscription). stripe-mock returns status=active for any
    // subscription retrieve, so this exercises the live branch end to end.
    const u = await createUser()
    await testDb().query(
      'UPDATE users SET stripe_customer_id = $1, stripe_subscription_id = $2, plan = $3 WHERE id = $4',
      ['cus_existing_test', 'sub_existing_test', 'free', u.id]
    )
    const client = await loggedInClient(u.id)
    const res = await client.post('/api/billing/checkout', { plan: 'pro' })
    expect(res.status).toBe(200)
    const body = await res.json() as { updated?: boolean, plan?: string, url?: string }
    expect(body.updated).toBe(true)
    expect(body.plan).toBe('pro')
    // Crucially: NO checkout URL — nothing to redirect to.
    expect(body.url).toBeUndefined()
  })

  it('409 when requesting the plan the user is already on', async () => {
    const u = await createUser()
    await testDb().query(
      'UPDATE users SET stripe_customer_id = $1, stripe_subscription_id = $2, plan = $3 WHERE id = $4',
      ['cus_existing_test', 'sub_existing_test', 'pro', u.id]
    )
    const client = await loggedInClient(u.id)
    const res = await client.post('/api/billing/checkout', { plan: 'pro' })
    expect(res.status).toBe(409)
  })

  it('still opens Checkout for a user with a customer id but no subscription id', async () => {
    // subscribed → cancelled (subscription id nulled by the deleted-
    // webhook) → resubscribes: fresh Checkout on the SAME customer.
    const u = await createUser()
    await testDb().query('UPDATE users SET stripe_customer_id = $1, stripe_subscription_id = NULL WHERE id = $2', ['cus_existing_test', u.id])
    const client = await loggedInClient(u.id)
    const res = await client.post('/api/billing/checkout', { plan: 'pro' })
    expect(res.status).toBe(200)
    const body = await res.json() as { url?: string, updated?: boolean }
    expect(body.url).toMatch(/^https?:\/\//)
    expect(body.updated).toBeUndefined()
  })

  it('401 when the session points at a user row that was deleted mid-flight', async () => {
    // Session cookies are sealed-string, not DB-backed, so a valid
    // session for a deleted user survives on the client. But
    // `requireValidatedUserSession` re-checks the user exists on
    // every request and clears the session on miss → 401. So the
    // 404 branch inside the checkout handler is a belt-and-braces
    // guard that's never reached in practice. This test pins the
    // earlier (401) layer that actually gates the request.
    const u = await createUser()
    const client = await loggedInClient(u.id)
    await testDb().query('DELETE FROM users WHERE id = $1', [u.id])
    const res = await client.post('/api/billing/checkout', { plan: 'pro' })
    expect(res.status).toBe(401)
  })

  // The remaining defensive branches (missing price id → 503,
  // Stripe returns a session with no URL → 502, Stripe rejects the
  // request → 502) are one-line `if`/`catch` guards whose correctness
  // is obvious from inspection. Triggering them via integration
  // would require per-test env mutation (we can't change
  // `useRuntimeConfig` after boot) or a live Stripe failure (can't
  // make stripe-mock reject a valid request). We accept the gap;
  // any refactor that broke these branches would be caught by TS or
  // a plain `grep` during review.
})

describe('POST /api/billing/portal', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('401 for anonymous callers', async () => {
    const res = await anonClient().post('/api/billing/portal')
    expect(res.status).toBe(401)
  })

  it('409 when user has no stripe_customer_id (never subscribed)', async () => {
    const u = await createUser()
    const client = await loggedInClient(u.id)
    const res = await client.post('/api/billing/portal')
    expect(res.status).toBe(409)
    const body = await res.json() as { message?: string }
    expect(body.message).toMatch(/subscribe first|billing history/i)
  })

  it('returns a portal URL for a user with an existing customer id', async () => {
    const u = await createUser()
    await testDb().query('UPDATE users SET stripe_customer_id = $1 WHERE id = $2', ['cus_existing_test', u.id])
    const client = await loggedInClient(u.id)
    const res = await client.post('/api/billing/portal')
    expect(res.status).toBe(200)
    const body = await res.json() as { url: string }
    expect(body.url).toMatch(/^https?:\/\//)
  })
})
