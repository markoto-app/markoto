import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, testDb } from '../setup/db'
import { anonClient, loggedInClient } from '../setup/client'
import { createUser } from '../setup/fixtures'
import { TIERS } from '../../../shared/config/tiers'

// GET /api/user/billing — session-level plan summary for the topbar /
// AI prompt bar. Workspace-scoped (+) attribution is NOT surfaced here
// (see prompt.post.ts where the resolver runs per-request with a
// workspace context).

describe('GET /api/user/billing', () => {
  beforeEach(async () => { await resetDb() })

  it('401 for an unauthenticated caller', async () => {
    const res = await anonClient().get('/api/user/billing')
    expect(res.status).toBe(401)
  })

  it('returns free-tier defaults for a fresh user', async () => {
    const u = await createUser()
    const client = await loggedInClient(u.id)
    const res = await client.get('/api/user/billing')
    expect(res.status).toBe(200)
    const body = await res.json() as {
      plan: string
      interactionsRemaining: number
      interactionsLimit: number
      periodStart: string
    }
    expect(body.plan).toBe('free')
    expect(body.interactionsLimit).toBe(TIERS.free.interactionsPerMonth)
    expect(body.interactionsRemaining).toBe(TIERS.free.interactionsPerMonth)
    // ISO string on the first of some month at midnight UTC.
    expect(body.periodStart).toMatch(/^\d{4}-\d{2}-01T00:00:00\.000Z$/)
  })

  it('reflects a paid plan when set in the DB', async () => {
    const u = await createUser()
    const db = testDb()
    const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    await db.query(
      'UPDATE users SET plan = $1, plan_valid_until = $2 WHERE id = $3',
      ['max', future, u.id]
    )
    const client = await loggedInClient(u.id)
    const res = await client.get('/api/user/billing')
    expect(res.status).toBe(200)
    const body = await res.json() as { plan: string, interactionsLimit: number }
    expect(body.plan).toBe('max')
    expect(body.interactionsLimit).toBe(TIERS.max.interactionsPerMonth)
  })

  it('subtracts recorded usage from the returned remaining', async () => {
    const u = await createUser()
    const db = testDb()
    // Seed this-month usage for the user attribution key.
    const periodStart = new Date(Date.UTC(
      new Date().getUTCFullYear(),
      new Date().getUTCMonth(),
      1, 0, 0, 0
    ))
    await db.query(
      `INSERT INTO ai_usage_period (attributed_to, period_start, interactions_used)
       VALUES ($1, $2, $3)`,
      [`user:${u.id}`, periodStart, 17]
    )
    const client = await loggedInClient(u.id)
    const res = await client.get('/api/user/billing')
    const body = await res.json() as { interactionsRemaining: number }
    expect(body.interactionsRemaining).toBe(TIERS.free.interactionsPerMonth - 17)
  })

  it('reports a lapsed paid plan as free (defensive downgrade)', async () => {
    // Pairs with the resolver test of the same name — proves the
    // endpoint surface also applies the same defensive downgrade,
    // not just the internal resolver.
    const u = await createUser()
    const db = testDb()
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
    await db.query(
      'UPDATE users SET plan = $1, plan_valid_until = $2 WHERE id = $3',
      ['pro', yesterday, u.id]
    )
    const client = await loggedInClient(u.id)
    const res = await client.get('/api/user/billing')
    const body = await res.json() as { plan: string, interactionsLimit: number }
    expect(body.plan).toBe('free')
    expect(body.interactionsLimit).toBe(TIERS.free.interactionsPerMonth)
  })
})
