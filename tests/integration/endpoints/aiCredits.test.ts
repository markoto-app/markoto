import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, testDb } from '../setup/db'
import { TEST_BASE_URL, TEST_BILLING_OFF_BASE_URL } from '../setup/env'
import { anonClient, loggedInClient } from '../setup/client'
import { createUser, createWorkspace } from '../setup/fixtures'
import { computeStripeSig, makeStripeEvent, TEST_WEBHOOK_SECRET } from '../setup/stripeHelpers'

// AI credit top-ups (WP4): checkout endpoints (stripe-mock), the webhook
// that records a paid top-up, refunds, and the balance in the billing
// endpoints. Budget arithmetic + settlement: tests/repos/aiCreditGrants
// and tests/integration/endpoints/aiCreditSettlementLitellm.

const FUTURE = new Date(Date.now() + 30 * 24 * 3600 * 1000)

async function postWebhook(event: unknown): Promise<Response> {
  const body = JSON.stringify(event)
  return fetch(`${TEST_BASE_URL}/api/webhooks/stripe`, {
    method: 'POST',
    headers: { 'stripe-signature': computeStripeSig(body, TEST_WEBHOOK_SECRET), 'content-type': 'application/json' },
    body
  })
}

function topupCompleted(args: { subjectType: 'user' | 'workspace', subjectId: string, pack?: string, paymentIntent: string, customer?: string, currency?: string, status?: string }) {
  return makeStripeEvent('checkout.session.completed', {
    id: `cs_topup_${args.paymentIntent}`,
    object: 'checkout.session',
    mode: 'payment',
    payment_status: args.status ?? 'paid',
    payment_intent: args.paymentIntent,
    customer: args.customer ?? null,
    currency: args.currency ?? 'eur',
    amount_total: 1000,
    client_reference_id: args.subjectType === 'user' ? args.subjectId : `workspace:${args.subjectId}`,
    metadata: { kind: 'topup', pack: args.pack ?? '10', subject_type: args.subjectType, subject_id: args.subjectId }
  })
}

async function grants(subjectType: string, subjectId: string): Promise<Array<{ amount_usd: number, remaining_usd: number, refunded_usd: number }>> {
  return (await testDb().query('SELECT amount_usd, remaining_usd, refunded_usd FROM ai_credit_grants WHERE subject_type = $1 AND subject_id = $2', [subjectType, subjectId])).rows
}

async function makePro(userId: number): Promise<void> {
  await testDb().query(`UPDATE users SET plan = 'pro', plan_valid_until = $2 WHERE id = $1`, [userId, FUTURE])
}

describe('POST /api/billing/topup (personal)', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('401 anonymous, 400 bad pack, 409 on the free plan', async () => {
    expect((await anonClient().post('/api/billing/topup', { pack: '10' })).status).toBe(401)
    const u = await createUser()
    const client = await loggedInClient(u.id)
    expect((await client.post('/api/billing/topup', { pack: '7' })).status).toBe(400)
    const free = await client.post('/api/billing/topup', { pack: '10' })
    expect(free.status).toBe(409)
    expect((await free.json() as { data?: { code?: string } }).data?.code).toBe('billing/topup-needs-plan')
  })

  it('Pro opens a one-time Checkout; the currency of an existing customer is locked', async () => {
    const u = await createUser()
    await makePro(u.id)
    const client = await loggedInClient(u.id)
    const res = await client.post('/api/billing/topup', { pack: '25' })
    expect(res.status).toBe(200)
    expect((await res.json() as { url?: string }).url).toMatch(/^https?:\/\//)

    await testDb().query(`UPDATE users SET stripe_customer_id = 'cus_x', billing_currency = 'eur' WHERE id = $1`, [u.id])
    const locked = await client.post('/api/billing/topup', { pack: '25', currency: 'chf' })
    expect(locked.status).toBe(409)
    expect((await locked.json() as { data?: { code?: string } }).data?.code).toBe('billing/currency-locked')
  })

  it('billing off: 404 billing/disabled', async () => {
    const u = await createUser()
    const res = await (await loggedInClient(u.id, undefined, TEST_BILLING_OFF_BASE_URL)).post('/api/billing/topup', { pack: '10' })
    expect(res.status).toBe(404)
  })
})

describe('POST /api/workspaces/:wsId/billing/topup', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('409 without an active subscription; Checkout on the workspace customer with one', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    const client = await loggedInClient(admin.id)
    const none = await client.post(`/api/workspaces/${ws.workspaceId}/billing/topup`, { pack: '50' })
    expect(none.status).toBe(409)

    await testDb().query(
      `INSERT INTO workspace_subscriptions (workspace_id, plan, seats, status, billing_admin_id, stripe_customer_id, stripe_subscription_id, valid_until)
       VALUES ($1, 'team', 3, 'active', $2, 'cus_ws_topup', 'sub_ws_topup', $3)`,
      [ws.workspaceId, admin.id, FUTURE]
    )
    const res = await client.post(`/api/workspaces/${ws.workspaceId}/billing/topup`, { pack: '50' })
    expect(res.status).toBe(200)
    expect((await res.json() as { url?: string }).url).toMatch(/^https?:\/\//)
  })
})

describe('webhook: top-ups', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('a paid top-up records the credit once and stamps a new personal customer', async () => {
    const u = await createUser()
    await makePro(u.id)
    expect((await postWebhook(topupCompleted({ subjectType: 'user', subjectId: String(u.id), pack: '25', paymentIntent: 'pi_a', customer: 'cus_new' }))).status).toBe(200)
    // Stripe redelivers with a new event id but the same payment.
    expect((await postWebhook(topupCompleted({ subjectType: 'user', subjectId: String(u.id), pack: '25', paymentIntent: 'pi_a', customer: 'cus_new' }))).status).toBe(200)
    expect(await grants('user', String(u.id))).toEqual([{ amount_usd: 25, remaining_usd: 25, refunded_usd: 0 }])
    const user = (await testDb().query('SELECT stripe_customer_id, billing_currency FROM users WHERE id = $1', [u.id])).rows[0]
    expect(user).toEqual({ stripe_customer_id: 'cus_new', billing_currency: 'eur' })

    const billing = await (await loggedInClient(u.id)).get('/api/user/billing')
    const body = await billing.json() as { credits: { usableUsd: number, grants: unknown[] } }
    expect(body.credits.usableUsd).toBe(25)
    expect(body.credits.grants).toHaveLength(1)
  })

  it('an unpaid or malformed payment checkout records nothing', async () => {
    const u = await createUser()
    await postWebhook(topupCompleted({ subjectType: 'user', subjectId: String(u.id), paymentIntent: 'pi_b', status: 'unpaid' }))
    const bad = topupCompleted({ subjectType: 'user', subjectId: String(u.id), paymentIntent: 'pi_c' })
    ;((bad.data as { object: { metadata: Record<string, string> } }).object.metadata).pack = '999'
    await postWebhook(bad)
    expect(await grants('user', String(u.id))).toEqual([])
  })

  it('a workspace top-up lands on the workspace; a refund takes the refunded share', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    await postWebhook(topupCompleted({ subjectType: 'workspace', subjectId: ws.workspaceId, pack: '50', paymentIntent: 'pi_ws' }))
    expect(await grants('workspace', ws.workspaceId)).toEqual([{ amount_usd: 50, remaining_usd: 50, refunded_usd: 0 }])

    const refund = makeStripeEvent('charge.refunded', {
      id: 'ch_ws', object: 'charge', payment_intent: 'pi_ws', amount: 5000, amount_refunded: 1000
    })
    expect((await postWebhook(refund)).status).toBe(200)
    expect(await grants('workspace', ws.workspaceId)).toEqual([{ amount_usd: 50, remaining_usd: 40, refunded_usd: 10 }])
  })
})
