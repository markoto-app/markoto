import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, testDb } from '../setup/db'
import { anonClient, loggedInClient } from '../setup/client'
import { createUser } from '../setup/fixtures'
import { DEFAULT_TIERS as TIERS } from '../../../shared/config/tiers'

// GET /api/user/billing — session-level plan summary for the topbar +
// pre-disabling new-workspace / knowledge-upload affordances. Phase 6
// moved AI quota to LiteLLM virtual keys, so this endpoint no longer
// surfaces interactions/points — that's `/api/ai/credits`. The shape
// here is plan + period + structural caps (workspaces / knowledge).

describe('GET /api/user/billing', () => {
  beforeEach(async () => {
    await resetDb()
  })

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
      workspacesOwnedLimit: number
      knowledgeFilesLimit: number
      knowledgeBytesPerUserLimit: number
      imageBytesPerUserLimit: number
      imageBytesUsed: number
      periodStart: string
    }
    expect(body.plan).toBe('free')
    expect(body.workspacesOwnedLimit).toBe(TIERS.free.workspacesOwned)
    expect(body.knowledgeFilesLimit).toBe(TIERS.free.knowledgeFiles)
    expect(body.knowledgeBytesPerUserLimit).toBe(TIERS.free.knowledgeBytesPerUser)
    expect(body.imageBytesPerUserLimit).toBe(TIERS.free.imageBytesPerUser)
    expect(body.imageBytesUsed).toBe(0)
    // ISO string on the first of some month at midnight UTC.
    expect(body.periodStart).toMatch(/^\d{4}-\d{2}-01T00:00:00\.000Z$/)
  })

  it('reflects a paid plan when set in the DB', async () => {
    const u = await createUser()
    const db = testDb()
    const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    await db.query(
      'UPDATE users SET plan = $1, plan_valid_until = $2 WHERE id = $3',
      ['pro', future, u.id]
    )
    const client = await loggedInClient(u.id)
    const res = await client.get('/api/user/billing')
    expect(res.status).toBe(200)
    const body = await res.json() as { plan: string, workspacesOwnedLimit: number }
    expect(body.plan).toBe('pro')
    expect(body.workspacesOwnedLimit).toBe(TIERS.pro.workspacesOwned)
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
    const body = await res.json() as { plan: string, workspacesOwnedLimit: number }
    expect(body.plan).toBe('free')
    expect(body.workspacesOwnedLimit).toBe(TIERS.free.workspacesOwned)
  })
})
