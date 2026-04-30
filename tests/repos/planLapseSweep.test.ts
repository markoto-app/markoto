import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, testDb } from '../integration/setup/db'
import { createUser, createWorkspace } from '../integration/setup/fixtures'
import { runPlanLapseSweep } from '../../server/utils/planLapseSweep'

// Plan-lapse sweep. Disables `(+)` on workspaces where the billing
// owner is no longer eligible (deleted, lapsed, downgraded). The
// runtime resolver already falls back to self-bill for these cases —
// the sweep just cleans up DB state so admin UI and analytics don't
// show stale "billing enabled" badges.

async function setPlan(
  userId: number,
  plan: 'free' | 'pro' | 'max' | 'ultra',
  validUntil: Date | null
): Promise<void> {
  const db = testDb()
  await db.query(
    'UPDATE users SET plan = $1, plan_valid_until = $2 WHERE id = $3',
    [plan, validUntil, userId]
  )
}

async function enableBilling(workspaceId: string, billingOwnerId: number | null): Promise<void> {
  const db = testDb()
  await db.query(
    'UPDATE workspaces SET ai_enabled = true, billing_owner_id = $1 WHERE workspace_id = $2',
    [billingOwnerId, workspaceId]
  )
}

async function readBilling(workspaceId: string): Promise<{
  aiEnabled: boolean
  billingOwnerId: number | null
}> {
  const r = await testDb().query<{ ai_enabled: boolean, billing_owner_id: number | null }>(
    'SELECT ai_enabled, billing_owner_id FROM workspaces WHERE workspace_id = $1',
    [workspaceId]
  )
  return {
    aiEnabled: r.rows[0].ai_enabled,
    billingOwnerId: r.rows[0].billing_owner_id
  }
}

describe('runPlanLapseSweep', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('disables (+) when billing_owner_id is NULL but ai_enabled is still true', async () => {
    // Case (a): the FK `ON DELETE SET NULL` nulled the owner when
    // they deleted their account, but nothing turned ai_enabled off.
    const creator = await createUser()
    const ws = await createWorkspace(creator.id)
    // Manually simulate the post-delete state (ai_enabled=true, owner=null).
    await testDb().query(
      'UPDATE workspaces SET ai_enabled = true, billing_owner_id = NULL WHERE workspace_id = $1',
      [ws.workspaceId]
    )

    const disabled = await runPlanLapseSweep()
    expect(disabled).toBeGreaterThanOrEqual(1)

    const state = await readBilling(ws.workspaceId)
    expect(state.aiEnabled).toBe(false)
  })

  it('disables (+) when billing owner\'s plan has LAPSED', async () => {
    const creator = await createUser()
    const sponsor = await createUser()
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
    await setPlan(sponsor.id, 'max', yesterday)
    const ws = await createWorkspace(creator.id)
    await enableBilling(ws.workspaceId, sponsor.id)

    await runPlanLapseSweep()
    const state = await readBilling(ws.workspaceId)
    expect(state.aiEnabled).toBe(false)
    expect(state.billingOwnerId).toBeNull()
  })

  it('disables (+) when billing owner was DOWNGRADED below max/ultra', async () => {
    // Scenario: a Max user enabled (+), then their Stripe subscription
    // changed to Pro via an upgrade/downgrade. The webhook flipped
    // `plan` to 'pro' but the workspace still has the Max-era `(+)`
    // state. Sweep must catch this too.
    const creator = await createUser()
    const sponsor = await createUser()
    const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    await setPlan(sponsor.id, 'pro', future) // downgraded to pro
    const ws = await createWorkspace(creator.id)
    await enableBilling(ws.workspaceId, sponsor.id)

    await runPlanLapseSweep()
    const state = await readBilling(ws.workspaceId)
    expect(state.aiEnabled).toBe(false)
  })

  it('LEAVES active Max/Ultra (+) workspaces untouched', async () => {
    // Critical negative test — a healthy (+) workspace must not be
    // swept. If this regressed, every active (+) would break on the
    // first hourly sweep post-deploy.
    const creator = await createUser()
    const sponsor = await createUser()
    const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    await setPlan(sponsor.id, 'max', future)
    const ws = await createWorkspace(creator.id)
    await enableBilling(ws.workspaceId, sponsor.id)

    await runPlanLapseSweep()
    const state = await readBilling(ws.workspaceId)
    expect(state.aiEnabled).toBe(true)
    expect(state.billingOwnerId).toBe(sponsor.id)
  })

  it('LEAVES Ultra with no planValidUntil as active (null = never lapses)', async () => {
    // Edge case: a test fixture or admin-seeded user with plan=ultra
    // but planValidUntil=NULL. The resolver treats NULL on a paid
    // plan as "never lapses" (pragmatic escape hatch for test data);
    // the sweep must match.
    const creator = await createUser()
    const sponsor = await createUser()
    await setPlan(sponsor.id, 'ultra', null)
    const ws = await createWorkspace(creator.id)
    await enableBilling(ws.workspaceId, sponsor.id)

    await runPlanLapseSweep()
    const state = await readBilling(ws.workspaceId)
    expect(state.aiEnabled).toBe(true)
  })

  it('LEAVES disabled workspaces alone (no work to do)', async () => {
    // Belt-and-braces: a (+)=false workspace should never be touched
    // by the sweep, even if its metadata looks off. The query
    // explicitly filters aiEnabled=true.
    const creator = await createUser()
    const ws = await createWorkspace(creator.id)
    // aiEnabled defaults to false on create.
    const before = await readBilling(ws.workspaceId)
    expect(before.aiEnabled).toBe(false)

    await runPlanLapseSweep()
    const after = await readBilling(ws.workspaceId)
    expect(after.aiEnabled).toBe(false)
    expect(after.billingOwnerId).toBeNull()
  })
})
