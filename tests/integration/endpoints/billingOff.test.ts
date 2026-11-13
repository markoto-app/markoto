import { describe, it, expect, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'
import { resetDb, testDb } from '../setup/db'
import { loggedInClient, anonClient } from '../setup/client'
import { createUser, createWorkspace } from '../setup/fixtures'
import { TEST_BILLING_OFF_BASE_URL } from '../setup/env'
import { at, first } from '../../helpers/assert'

// Billing-off mode over real HTTP. These tests talk to the SECOND
// Nitro subprocess (TEST_BILLING_OFF_BASE_URL), booted from the same
// build with NUXT_BILLING_ENABLED off, NUXT_PLANS_COMING_SOON=true and
// no NUXT_STRIPE_* variables at all, so its successful boot is itself
// the "runs without Stripe config" check. A few cases hit the primary
// (billing ON) server to pin the inverse.

const OFF = TEST_BILLING_OFF_BASE_URL

function sha256(v: string): string {
  return createHash('sha256').update(v).digest('hex')
}

async function waitlistRows() {
  const r = await testDb().query<{
    email: string
    locale: string
    user_id: number | null
    consent_version: number
    consent_text_id: string
    confirm_token_hash: string | null
    unsubscribe_token_hash: string
    confirmed_at: Date | null
  }>('SELECT email, locale, user_id, consent_version, consent_text_id, confirm_token_hash, unsubscribe_token_hash, confirmed_at FROM waitlist_signups ORDER BY id')
  return r.rows
}

async function seedPendingSignup(email: string, confirmToken: string, unsubscribeToken: string): Promise<void> {
  await testDb().query(
    `INSERT INTO waitlist_signups (email, locale, consent_version, consent_text_id, confirm_token_hash, confirm_token_expires_at, unsubscribe_token_hash)
     VALUES ($1, 'en', 1, 'waitlist.consentLabel', $2, NOW() + interval '7 days', $3)`,
    [email, sha256(confirmToken), sha256(unsubscribeToken)]
  )
}

describe('billing off: billing endpoints are absent', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('boots without Stripe config and serves normal traffic', async () => {
    const res = await anonClient(OFF).get('/api/version')
    expect(res.status).toBe(200)
  })

  it('checkout + portal answer 404 billing/disabled for a signed-in user', async () => {
    const u = await createUser()
    const client = await loggedInClient(u.id, undefined, OFF)
    for (const path of ['/api/billing/checkout', '/api/billing/portal']) {
      const res = await client.post(path, { plan: 'pro' })
      expect(res.status, path).toBe(404)
      const body = await res.json() as { data?: { code?: string } }
      expect(body.data?.code, path).toBe('billing/disabled')
    }
  })

  it('the Stripe webhook answers 404 billing/disabled (no signature check, no Stripe call)', async () => {
    const res = await anonClient(OFF).post('/api/webhooks/stripe', { id: 'evt_x', type: 'checkout.session.completed' }, {
      headers: { 'stripe-signature': 't=1,v1=deadbeef' }
    })
    expect(res.status).toBe(404)
    const body = await res.json() as { data?: { code?: string } }
    expect(body.data?.code).toBe('billing/disabled')
  })

  it('the public tier map still serves (pricing page renders limits)', async () => {
    const res = await anonClient(OFF).get('/api/billing/tiers')
    expect(res.status).toBe(200)
    const body = await res.json() as { free?: { workspacesOwned?: number } }
    expect(body.free?.workspacesOwned).toBeGreaterThan(0)
  })

  it('a stored paid plan resolves to free for limits', async () => {
    const u = await createUser()
    await testDb().query(
      'UPDATE users SET plan = $1, plan_valid_until = $2, stripe_current_period_start = $3 WHERE id = $4',
      ['pro', new Date(Date.now() + 20 * 86_400_000), new Date(Date.now() - 5 * 86_400_000), u.id]
    )
    const client = await loggedInClient(u.id, undefined, OFF)
    const res = await client.get('/api/user/billing')
    expect(res.status).toBe(200)
    const body = await res.json() as { plan: string }
    expect(body.plan).toBe('free')
  })

  it('a workspace-cap error carries no upgrade link to a non-existent purchase', async () => {
    const u = await createUser()
    const client = await loggedInClient(u.id, undefined, OFF)
    // Free tier owns 1 workspace by default.
    await createWorkspace(u.id)
    const res = await client.post('/api/workspaces', { name: 'Second' })
    expect(res.status).toBe(409)
    const body = await res.json() as { message?: string, data?: { code?: string, recovery?: { labelKey?: string } } }
    expect(body.data?.code).toBe('workspace/cap-reached')
    expect(body.message).not.toMatch(/upgrade|\/pricing/i)
    // Hosted SaaS mode: the recovery points at the coming-soon page.
    expect(body.data?.recovery?.labelKey).toBe('billing.comingSoonCta')
  })
})

describe('billing off: SSR billing mode reaches the browser', () => {
  it('pricing page renders the coming-soon tiers with PLANNED prices + waitlist, no checkout', async () => {
    const res = await anonClient(OFF).get('/pricing')
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('data-testid="waitlist-section"')
    expect(html).toContain('data-testid="pricing-coming-soon-badge"')
    expect(html).toContain('data-testid="pricing-planned-note"')
    expect(html).toContain('Planned price')
    expect(html).toContain('data-testid="pricing-join-waitlist"')
    expect(html).not.toMatch(/>\s*Upgrade\s*</)
  })

  it('billing on: same page shows prices and no waitlist', async () => {
    const res = await anonClient().get('/pricing')
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('€9')
    expect(html).not.toContain('data-testid="waitlist-section"')
  })
})

describe('waitlist: sign-up (billing off + plans coming soon)', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('202 + one UNCONFIRMED row with normalised email, consent record and hashed tokens', async () => {
    const res = await anonClient(OFF).post('/api/waitlist', { email: '  Maya@Example.COM ', locale: 'de', consent: true })
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ ok: true })

    const rows = await waitlistRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      email: 'maya@example.com',
      locale: 'de',
      user_id: null,
      consent_version: 1,
      consent_text_id: 'waitlist.consentLabel',
      confirmed_at: null
    })
    expect(at(rows).confirm_token_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(first(rows).unsubscribe_token_hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('rejects a missing / non-true consent with 400 and stores nothing', async () => {
    for (const consent of [undefined, false, 'true', 1]) {
      const res = await anonClient(OFF).post('/api/waitlist', { email: 'maya@example.com', consent })
      expect(res.status, String(consent)).toBe(400)
      const body = await res.json() as { data?: { code?: string } }
      expect(body.data?.code).toBe('waitlist/consent-required')
    }
    expect(await waitlistRows()).toHaveLength(0)
  })

  it('rejects an invalid email with 400', async () => {
    const res = await anonClient(OFF).post('/api/waitlist', { email: 'nope', consent: true })
    expect(res.status).toBe(400)
    const body = await res.json() as { data?: { code?: string } }
    expect(body.data?.code).toBe('waitlist/invalid-email')
  })

  it('re-signup is idempotent and indistinguishable from a first sign-up (no oracle)', async () => {
    const first = await anonClient(OFF).post('/api/waitlist', { email: 'maya@example.com', consent: true })
    const pendingHash = at(await waitlistRows()).confirm_token_hash
    const second = await anonClient(OFF).post('/api/waitlist', { email: 'MAYA@example.com', consent: true })
    expect(second.status).toBe(first.status)
    expect(await second.json()).toEqual({ ok: true })
    const rows = await waitlistRows()
    expect(rows).toHaveLength(1)
    // Unconfirmed re-signup rotates the confirm token (old link dies).
    expect(at(rows).confirm_token_hash).not.toBe(pendingHash)

    // Already-confirmed address: same response, nothing changes.
    await testDb().query('UPDATE waitlist_signups SET confirmed_at = NOW(), confirm_token_hash = NULL')
    const before = (await waitlistRows())[0]
    const third = await anonClient(OFF).post('/api/waitlist', { email: 'maya@example.com', consent: true })
    expect(third.status).toBe(202)
    expect(await third.json()).toEqual({ ok: true })
    expect((await waitlistRows())[0]).toEqual(before)
  })

  it('links the row to the signed-in account', async () => {
    const u = await createUser()
    const client = await loggedInClient(u.id, undefined, OFF)
    const res = await client.post('/api/waitlist', { email: 'linked@example.com', consent: true })
    expect(res.status).toBe(202)
    expect(first(await waitlistRows()).user_id).toBe(u.id)
  })

  it('billing on (primary server): sign-up is 404 waitlist/disabled', async () => {
    const res = await anonClient().post('/api/waitlist', { email: 'maya@example.com', consent: true })
    expect(res.status).toBe(404)
    const body = await res.json() as { data?: { code?: string } }
    expect(body.data?.code).toBe('waitlist/disabled')
    expect(await waitlistRows()).toHaveLength(0)
  })
})

describe('waitlist: confirm + unsubscribe', () => {
  beforeEach(async () => {
    await resetDb()
  })

  const CONFIRM = 'confirm-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  const UNSUB = 'unsub-token-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

  it('confirm sets confirmed_at once; a reused token is 400 invalid-token', async () => {
    await seedPendingSignup('maya@example.com', CONFIRM, UNSUB)
    const ok = await anonClient(OFF).post('/api/waitlist/confirm', { token: CONFIRM })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ confirmed: true })
    const row = first(await waitlistRows())
    expect(row.confirmed_at).not.toBeNull()
    expect(row.confirm_token_hash).toBeNull()

    const again = await anonClient(OFF).post('/api/waitlist/confirm', { token: CONFIRM })
    expect(again.status).toBe(400)
    const body = await again.json() as { data?: { code?: string } }
    expect(body.data?.code).toBe('waitlist/invalid-token')
  })

  it('confirm rejects unknown and malformed tokens with the same 400', async () => {
    for (const token of ['x'.repeat(43), 'short', undefined]) {
      const res = await anonClient(OFF).post('/api/waitlist/confirm', { token })
      expect(res.status, String(token)).toBe(400)
    }
  })

  it('unsubscribe deletes the row and stays 200 on repeat', async () => {
    await seedPendingSignup('maya@example.com', CONFIRM, UNSUB)
    const first = await anonClient(OFF).post('/api/waitlist/unsubscribe', { token: UNSUB })
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual({ unsubscribed: true })
    expect(await waitlistRows()).toHaveLength(0)

    const second = await anonClient(OFF).post('/api/waitlist/unsubscribe', { token: UNSUB })
    expect(second.status).toBe(200)
  })

  it('unsubscribe keeps working when billing is on (withdrawing consent never depends on a flag)', async () => {
    await seedPendingSignup('maya@example.com', CONFIRM, UNSUB)
    const res = await anonClient().post('/api/waitlist/unsubscribe', { token: UNSUB })
    expect(res.status).toBe(200)
    expect(await waitlistRows()).toHaveLength(0)
  })
})
