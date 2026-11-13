import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, testDb } from '../setup/db'
import { loggedInClient } from '../setup/client'
import { createUser, createWorkspace } from '../setup/fixtures'
import { DEFAULT_TIERS as TIERS } from '../../../shared/config/tiers'

// Tier-aware per-user workspace cap. Every tier has a distinct
// `workspacesOwned` ceiling; POST /api/workspaces reads the caller's
// plan and 409s when they're at cap. Test each tier's boundary.

async function setUserPlan(
  userId: number,
  plan: 'free' | 'pro'
): Promise<void> {
  const db = testDb()
  const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
  await db.query(
    'UPDATE users SET plan = $1, plan_valid_until = $2 WHERE id = $3',
    [plan, plan === 'free' ? null : future, userId]
  )
}

describe('POST /api/workspaces: tier-aware workspacesOwned cap', () => {
  beforeEach(async () => {
    await resetDb()
  })

  // Parameterised: one scenario per tier. Creating (cap-1) workspaces
  // via the repo fixture + one more via the endpoint asserts the cap
  // boundary for each personal plan.
  const scenarios: Array<{ plan: 'free' | 'pro', cap: number }> = [
    { plan: 'free', cap: TIERS.free.workspacesOwned },
    { plan: 'pro', cap: TIERS.pro.workspacesOwned }
  ]

  for (const { plan, cap } of scenarios) {
    it(`${plan}: one more than ${cap} returns 409 with plan-aware message`, async () => {
      const u = await createUser()
      await setUserPlan(u.id, plan)

      // Seed cap workspaces directly. Each call creates a workspaces
      // row owned by u; we just need the COUNT to match cap so the
      // next endpoint create trips the limit.
      for (let i = 0; i < cap; i++) {
        await createWorkspace(u.id)
      }

      const client = await loggedInClient(u.id)
      const res = await client.post('/api/workspaces', { name: 'one too many' })
      expect(res.status).toBe(409)
      const body = await res.json() as { message?: string, data?: { plan?: string, cap?: number } }
      expect(body.data?.plan).toBe(plan)
      expect(body.data?.cap).toBe(cap)
      expect(body.message).toMatch(new RegExp(plan, 'i'))
    })

    it(`${plan}: exactly cap-1 works (at-limit succeeds)`, async () => {
      const u = await createUser()
      await setUserPlan(u.id, plan)
      for (let i = 0; i < cap - 1; i++) {
        await createWorkspace(u.id)
      }
      const client = await loggedInClient(u.id)
      const res = await client.post('/api/workspaces', { name: 'at limit' })
      expect(res.status).toBe(200)
    })
  }

  it('lapsed paid plan falls back to free-tier cap', async () => {
    // A Pro user whose plan_valid_until is in the past should see the
    // Free cap (1), not the Pro cap (10). Defensive downgrade while
    // the plan-lapse sweep catches up.
    const u = await createUser()
    const db = testDb()
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
    await db.query(
      'UPDATE users SET plan = $1, plan_valid_until = $2 WHERE id = $3',
      ['pro', yesterday, u.id]
    )
    // Seed 1 workspace → at free cap.
    await createWorkspace(u.id)

    const client = await loggedInClient(u.id)
    const res = await client.post('/api/workspaces', { name: 'two?' })
    expect(res.status).toBe(409)
    const body = await res.json() as { data?: { plan?: string, cap?: number } }
    expect(body.data?.plan).toBe('free')
    expect(body.data?.cap).toBe(TIERS.free.workspacesOwned)
  })
})
