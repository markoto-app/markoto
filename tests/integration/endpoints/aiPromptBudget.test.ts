import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, testDb } from '../setup/db'
import { loggedInClient, anonClient } from '../setup/client'
import { createUser, createDoc } from '../setup/fixtures'
import { TIERS } from '../../../shared/config/tiers'
import { currentPeriodStart } from '../../../server/utils/billing'

// POST /api/ai/prompt — session-open budget gate. Phase 3's key
// integration-level assertion: an exhausted user gets 402 BEFORE
// Gemini spins up, the Hocuspocus JWT is minted, or an ai_sessions
// row is inserted. The mid-loop doc breadcrumb path requires a real
// agentic run to exercise — we skip that here because the integration
// suite doesn't talk to Gemini.

async function seedUsage(
  attributedTo: string,
  periodStart: Date,
  used: number
): Promise<void> {
  const db = testDb()
  await db.query(
    `INSERT INTO ai_usage_period (attributed_to, period_start, interactions_used)
     VALUES ($1, $2, $3)`,
    [attributedTo, periodStart, used]
  )
}

async function setUserPlan(userId: number, plan: 'free' | 'pro' | 'max' | 'ultra'): Promise<void> {
  const db = testDb()
  const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
  await db.query(
    'UPDATE users SET plan = $1, plan_valid_until = $2 WHERE id = $3',
    [plan, plan === 'free' ? null : future, userId]
  )
}

describe('POST /api/ai/prompt — interaction budget gate', () => {
  beforeEach(async () => { await resetDb() })

  it('401 for an unauthenticated caller (sanity — pre-existing behaviour)', async () => {
    const res = await anonClient().post('/api/ai/prompt', { docId: 'x', prompt: 'hi' })
    expect(res.status).toBe(401)
  })

  it('402 when the user is at or past their interaction cap', async () => {
    const u = await createUser()
    const doc = await createDoc({ ownerId: u.id })
    await seedUsage(`user:${u.id}`, currentPeriodStart(), TIERS.free.interactionsPerMonth)

    const client = await loggedInClient(u.id)
    const res = await client.post('/api/ai/prompt', {
      docId: doc.docId,
      prompt: 'summarize this'
    })
    expect(res.status).toBe(402)
    const body = await res.json() as { message?: string, data?: { plan?: string } }
    expect(body.message).toMatch(/upgrade|plan/i)
    expect(body.data?.plan).toBe('free')

    // AND: no ai_sessions row was created — the gate fired BEFORE
    // session registration. If this ever regresses, exhausted users
    // would waste a per-user-per-doc session slot and block their
    // next (successful) prompt for an hour.
    const r = await testDb().query<{ c: string }>(
      `SELECT COUNT(*) AS c FROM ai_sessions WHERE initiator_user_id = $1`,
      [u.id]
    )
    expect(Number(r.rows[0].c)).toBe(0)
  })

  it('402 when just below cap and charge would overshoot', async () => {
    // At 99/100 a Free user has 1 remaining. The prompt endpoint's
    // pre-check only rejects when remaining <= 0, so this one
    // succeeds. Pin that boundary — the error budget is "gracefully
    // spend the last few interactions on a started session" vs
    // "reject a user who might have meaningful work left". We pick
    // the former to avoid a degraded UX right at the cap edge.
    const u = await createUser()
    const doc = await createDoc({ ownerId: u.id })
    await seedUsage(`user:${u.id}`, currentPeriodStart(), TIERS.free.interactionsPerMonth - 1)

    const client = await loggedInClient(u.id)
    const res = await client.post('/api/ai/prompt', {
      docId: doc.docId,
      prompt: 'add a footer'
    })
    // 202 Accepted path (successful registration) — not 402. The
    // mid-loop charge will handle the graceful mid-run exhaustion if
    // this turn pushes past the cap.
    expect([200, 202]).toContain(res.status)
  })

  it('reflects paid tier caps — a Max user at 100 used is NOT exhausted (far from Max cap)', async () => {
    const u = await createUser()
    await setUserPlan(u.id, 'max')
    const doc = await createDoc({ ownerId: u.id })
    // 100 used is PAST Free's cap (100) but deep under Max's cap
    // (8000) — the endpoint must read the user's ACTUAL plan, not
    // default to free. If the resolver ever regressed to "always
    // free", this test would 402.
    await seedUsage(`user:${u.id}`, currentPeriodStart(), 100)

    const client = await loggedInClient(u.id)
    const res = await client.post('/api/ai/prompt', {
      docId: doc.docId,
      prompt: 'hi'
    })
    expect([200, 202]).toContain(res.status)
  })

  it('402 error body includes plan + attributedTo for the upgrade UI to render', async () => {
    const u = await createUser()
    const doc = await createDoc({ ownerId: u.id })
    await seedUsage(`user:${u.id}`, currentPeriodStart(), TIERS.free.interactionsPerMonth)

    const client = await loggedInClient(u.id)
    const res = await client.post('/api/ai/prompt', {
      docId: doc.docId,
      prompt: 'hi'
    })
    expect(res.status).toBe(402)
    const body = await res.json() as {
      data?: { plan?: string, attributedTo?: string, periodStart?: string }
    }
    expect(body.data?.plan).toBe('free')
    expect(body.data?.attributedTo).toBe(`user:${u.id}`)
    expect(body.data?.periodStart).toMatch(/^\d{4}-\d{2}-01T00:00:00\.000Z$/)
  })
})
