import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, testDb } from '../setup/db'
import { anonClient, loggedInClient } from '../setup/client'
import { createUser, createWorkspace, setMemberRole } from '../setup/fixtures'

// PATCH /api/workspaces/:wsId/billing — (+) team-billing toggle.
// Four axes of behaviour:
//   1. Auth + role (admin-only)
//   2. Plan eligibility (max/ultra only to ENABLE; anyone to DISABLE)
//   3. Lapsed paid plan blocks enabling
//   4. DB writes are atomic (ai_enabled + billing_owner_id always consistent)

async function setUserPlan(
  userId: number,
  plan: 'free' | 'pro' | 'max' | 'ultra',
  validUntil: Date | null = null
): Promise<void> {
  const db = testDb()
  await db.query(
    'UPDATE users SET plan = $1, plan_valid_until = $2 WHERE id = $3',
    [plan, validUntil, userId]
  )
}

async function readBilling(workspaceId: string): Promise<{
  aiEnabled: boolean
  billingOwnerId: number | null
}> {
  const db = testDb()
  const r = await db.query<{ ai_enabled: boolean, billing_owner_id: number | null }>(
    'SELECT ai_enabled, billing_owner_id FROM workspaces WHERE workspace_id = $1',
    [workspaceId]
  )
  return {
    aiEnabled: r.rows[0].ai_enabled,
    billingOwnerId: r.rows[0].billing_owner_id
  }
}

describe('PATCH /api/workspaces/:wsId/billing', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('401 for unauthenticated caller', async () => {
    const owner = await createUser()
    const ws = await createWorkspace(owner.id)
    const res = await anonClient().patch(`/api/workspaces/${ws.workspaceId}/billing`, {
      aiEnabled: true
    })
    expect(res.status).toBe(401)
  })

  it('403 for non-admin members (editor can\'t toggle)', async () => {
    const owner = await createUser()
    const editor = await createUser()
    const ws = await createWorkspace(owner.id)
    await setMemberRole(ws.workspaceId, editor.id, 'editor')
    await setUserPlan(editor.id, 'max', new Date(Date.now() + 1e10))

    const client = await loggedInClient(editor.id)
    const res = await client.patch(`/api/workspaces/${ws.workspaceId}/billing`, {
      aiEnabled: true
    })
    expect(res.status).toBe(403)
    // Not persisted.
    const state = await readBilling(ws.workspaceId)
    expect(state.aiEnabled).toBe(false)
  })

  it('404 for non-member admin of a different workspace', async () => {
    // A user's "admin" role doesn't carry across workspaces. Someone
    // who admins workspace A must not be able to toggle workspace B's
    // billing without a membership row in B.
    const ownerA = await createUser()
    const ownerB = await createUser()
    const wsB = await createWorkspace(ownerB.id)
    await setUserPlan(ownerA.id, 'max', new Date(Date.now() + 1e10))

    const client = await loggedInClient(ownerA.id)
    const res = await client.patch(`/api/workspaces/${wsB.workspaceId}/billing`, {
      aiEnabled: true
    })
    // 404 not 403 — we intentionally don't leak workspace existence to
    // non-members. Mirrors the listing-endpoint's "not found" pattern.
    expect(res.status).toBe(404)
  })

  it('400 when body.aiEnabled is missing or non-boolean', async () => {
    const owner = await createUser()
    const ws = await createWorkspace(owner.id)
    await setUserPlan(owner.id, 'max', new Date(Date.now() + 1e10))
    const client = await loggedInClient(owner.id)

    for (const bad of [{}, { aiEnabled: 'yes' }, { aiEnabled: 1 }, { aiEnabled: null }]) {
      const res = await client.patch(`/api/workspaces/${ws.workspaceId}/billing`, bad)
      expect(res.status).toBe(400)
    }
  })

  it('403 when admin tries to enable without Max/Ultra plan', async () => {
    const owner = await createUser()
    await setUserPlan(owner.id, 'pro', new Date(Date.now() + 1e10))
    const ws = await createWorkspace(owner.id)
    const client = await loggedInClient(owner.id)
    const res = await client.patch(`/api/workspaces/${ws.workspaceId}/billing`, {
      aiEnabled: true
    })
    expect(res.status).toBe(403)
    const body = await res.json() as { message?: string, data?: { callerPlan?: string } }
    expect(body.message).toMatch(/max or ultra/i)
    expect(body.data?.callerPlan).toBe('pro')
  })

  it('403 when admin has a LAPSED Max plan', async () => {
    const owner = await createUser()
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
    await setUserPlan(owner.id, 'max', yesterday)
    const ws = await createWorkspace(owner.id)
    const client = await loggedInClient(owner.id)
    const res = await client.patch(`/api/workspaces/${ws.workspaceId}/billing`, {
      aiEnabled: true
    })
    expect(res.status).toBe(403)
    const body = await res.json() as { message?: string }
    expect(body.message).toMatch(/lapsed|renew/i)
  })

  it('success: Max admin enabling (+) sets aiEnabled=true + billingOwnerId=self', async () => {
    const owner = await createUser()
    await setUserPlan(owner.id, 'max', new Date(Date.now() + 1e10))
    const ws = await createWorkspace(owner.id)
    const client = await loggedInClient(owner.id)
    const res = await client.patch(`/api/workspaces/${ws.workspaceId}/billing`, {
      aiEnabled: true
    })
    expect(res.status).toBe(200)
    const body = await res.json() as {
      aiEnabled: boolean
      billingOwnerId: number
      billingOwnerPlan: string
    }
    expect(body.aiEnabled).toBe(true)
    expect(body.billingOwnerId).toBe(owner.id)
    expect(body.billingOwnerPlan).toBe('max')

    // Persisted atomically — aiEnabled=true and billingOwnerId non-null
    // always land together. If aiEnabled were set without billingOwnerId,
    // the resolver's (+) branch would crash or silently fall through.
    const state = await readBilling(ws.workspaceId)
    expect(state.aiEnabled).toBe(true)
    expect(state.billingOwnerId).toBe(owner.id)
  })

  it('disabling (+) always allowed, even from Free admin (no plan check)', async () => {
    // Scenario: a Max admin enabled (+), then downgraded to Free. The
    // plan-lapse sweep would eventually turn it off, but we don't
    // want to require the paid plan to DISABLE — a user in the midst
    // of a downgrade should always be able to back out.
    const owner = await createUser()
    const ws = await createWorkspace(owner.id)
    // Seed an "already enabled" state directly (skipping the plan
    // gate — simulating post-lapse).
    await testDb().query(
      'UPDATE workspaces SET ai_enabled = true, billing_owner_id = $1 WHERE workspace_id = $2',
      [owner.id, ws.workspaceId]
    )
    await setUserPlan(owner.id, 'free')

    const client = await loggedInClient(owner.id)
    const res = await client.patch(`/api/workspaces/${ws.workspaceId}/billing`, {
      aiEnabled: false
    })
    expect(res.status).toBe(200)
    const state = await readBilling(ws.workspaceId)
    expect(state.aiEnabled).toBe(false)
    expect(state.billingOwnerId).toBeNull() // Disable nulls both atomically
  })

  it('billing state is exposed on GET /api/workspaces/:wsId', async () => {
    // The workspace GET surfaces {aiEnabled, billingOwnerId} so the
    // UI can render the toggle state + "billed to X" banner without
    // a second call.
    const owner = await createUser()
    await setUserPlan(owner.id, 'ultra', new Date(Date.now() + 1e10))
    const ws = await createWorkspace(owner.id)
    const client = await loggedInClient(owner.id)
    await client.patch(`/api/workspaces/${ws.workspaceId}/billing`, { aiEnabled: true })

    const res = await client.get(`/api/workspaces/${ws.workspaceId}`)
    expect(res.status).toBe(200)
    const body = await res.json() as { workspace: {
      aiEnabled: boolean
      billingOwnerId: number | null
    } }
    expect(body.workspace.aiEnabled).toBe(true)
    expect(body.workspace.billingOwnerId).toBe(owner.id)
  })
})
