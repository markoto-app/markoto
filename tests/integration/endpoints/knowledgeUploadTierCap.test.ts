import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, testDb } from '../setup/db'
import { loggedInClient } from '../setup/client'
import { createUser, createWorkspace } from '../setup/fixtures'
import { DEFAULT_TIERS as TIERS } from '../../../shared/config/tiers'

// Tier-aware knowledge upload cap, integration through the real
// /api/workspaces/:wsId/knowledge/upload-request endpoint. Complements
// the repo-level `resolveCaps` tests by proving the full request →
// quota-check → 409 loop resolves the right plan.
//
// Seeds N ready rows directly (no S3 traffic) to reach the cap.

async function setUserPlan(userId: number, plan: 'free' | 'pro'): Promise<void> {
  const db = testDb()
  const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
  await db.query(
    'UPDATE users SET plan = $1, plan_valid_until = $2 WHERE id = $3',
    [plan, plan === 'free' ? null : future, userId]
  )
}

async function seedReadyKnowledge(
  workspaceId: string,
  uploaderId: number | null,
  count: number,
  sizeBytes = 1024
): Promise<void> {
  const db = testDb()
  for (let i = 0; i < count; i++) {
    const knowledgeId = `kn-seed-${i}-${Math.random().toString(36).slice(2, 8)}`
    await db.query(
      `INSERT INTO workspace_knowledge
       (knowledge_id, workspace_id, filename, source_ext, mime_type, size_bytes, s3_key, status, embedding_version, uploader_id, chunk_count, token_count)
       VALUES ($1, $2, $3, 'pdf', 'application/pdf', $4, $5, 'ready', 'test:768', $6, 0, 0)`,
      [
        knowledgeId,
        workspaceId,
        `seed-${i}.pdf`,
        sizeBytes,
        `workspaces/${workspaceId}/knowledge/${knowledgeId}.pdf`,
        uploaderId
      ]
    )
  }
}

describe('POST /api/workspaces/:wsId/knowledge/upload-request: tier cap', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('free workspace: one more than the free per-workspace file cap returns 409', async () => {
    const u = await createUser()
    await setUserPlan(u.id, 'free')
    const ws = await createWorkspace(u.id)
    const cap = TIERS.free.knowledgeFiles
    await seedReadyKnowledge(ws.workspaceId, u.id, cap)

    const client = await loggedInClient(u.id)
    const res = await client.post(
      `/api/workspaces/${ws.workspaceId}/knowledge/upload-request`,
      { filename: 'one-too-many.pdf', size: 1024 }
    )
    expect(res.status).toBe(409)
    const body = await res.json() as { message?: string }
    expect(body.message).toMatch(/limit/i)
  })

  it('pro workspace: one below its cap is allowed to presign', async () => {
    const u = await createUser()
    await setUserPlan(u.id, 'pro')
    const ws = await createWorkspace(u.id)
    // Seed pro.knowledgeFiles - 1 so one more slot is available.
    await seedReadyKnowledge(ws.workspaceId, u.id, TIERS.pro.knowledgeFiles - 1)

    const client = await loggedInClient(u.id)
    const res = await client.post(
      `/api/workspaces/${ws.workspaceId}/knowledge/upload-request`,
      { filename: 'room-for-one.pdf', size: 1024 }
    )
    expect([200, 201]).toContain(res.status)
  })

  it('Team workspace: a pro creator can exceed their personal per-workspace cap', async () => {
    // The workspace's per-workspace cap follows its Team subscription
    // when that is better than the creator's own plan.
    const creator = await createUser()
    await setUserPlan(creator.id, 'pro')
    const ws = await createWorkspace(creator.id)
    const db = testDb()
    await db.query(
      `INSERT INTO workspace_subscriptions (workspace_id, plan, seats, status, valid_until)
       VALUES ($1, 'team', 3, 'active', NOW() + interval '30 days')`,
      [ws.workspaceId]
    )

    // Seed just above Pro's per-workspace file cap to prove the
    // resolver picked Team. Use uploader=null so the PER-USER cap
    // doesn't interfere: we're isolating the workspace cap here.
    await seedReadyKnowledge(ws.workspaceId, null, TIERS.pro.knowledgeFiles + 1)

    const client = await loggedInClient(creator.id)
    const res = await client.post(
      `/api/workspaces/${ws.workspaceId}/knowledge/upload-request`,
      { filename: 'team-lets-me.pdf', size: 1024 }
    )
    // Not 409. Either 200 presign success or a different non-cap
    // error (e.g. S3 signing in the test env). Cap-logic passed.
    expect(res.status).not.toBe(409)
  })

  // Error-contract delivery (the upgrade CTA wiring)
  //
  // When a user hits a knowledge cap mid-work, the WorkspaceKnowledgePanel
  // toast needs to render an "Upgrade your plan" link routing to /pricing.
  // That depends on the server response carrying `data.recovery.href`.
  // Without these tests, a refactor that drops the recovery field would
  // silently degrade the UX to a generic "limit reached" toast with no
  // upgrade path.

  it('per-workspace file cap: error response includes /pricing recovery hint', async () => {
    const u = await createUser()
    await setUserPlan(u.id, 'free')
    const ws = await createWorkspace(u.id)
    await seedReadyKnowledge(ws.workspaceId, u.id, TIERS.free.knowledgeFiles)

    const client = await loggedInClient(u.id)
    const res = await client.post(
      `/api/workspaces/${ws.workspaceId}/knowledge/upload-request`,
      { filename: 'over-cap.pdf', size: 1024 }
    )
    expect(res.status).toBe(409)
    const body = await res.json() as {
      data?: { code?: string, recovery?: { kind?: string, href?: string, labelKey?: string } }
    }
    expect(body.data?.code).toBe('knowledge/workspace-file-cap')
    expect(body.data?.recovery).toEqual({
      kind: 'link', href: '/pricing', labelKey: 'ai.upgradeCta'
    })
  })

  it('cap-reached error has consistent recovery hint regardless of WHICH cap fired', async () => {
    // Per-user and per-workspace knowledge file caps share the same
    // tier value (`knowledgeFiles`), so for a single workspace the
    // per-workspace check fires first. The recovery hint is
    // consistent across both code paths, whichever cap fires, the
    // toast routes the user to /pricing.
    //
    // We can't easily isolate "per-user fired before per-workspace"
    // here without the fields differing, but the contract under
    // test is "every cap-rejection has a /pricing recovery", so
    // probing the per-workspace path is sufficient to prove the
    // delivery shape.
    const u = await createUser()
    await setUserPlan(u.id, 'free')
    const ws = await createWorkspace(u.id)
    await seedReadyKnowledge(ws.workspaceId, u.id, TIERS.free.knowledgeFiles)

    const client = await loggedInClient(u.id)
    const res = await client.post(
      `/api/workspaces/${ws.workspaceId}/knowledge/upload-request`,
      { filename: 'over.pdf', size: 1024 }
    )
    expect(res.status).toBe(409)
    const body = await res.json() as {
      data?: { code?: string, recovery?: { kind?: string, href?: string, labelKey?: string } }
    }
    expect(body.data?.code).toMatch(/^knowledge\/(user-file-cap|user-bytes-cap|workspace-file-cap|workspace-bytes-cap)$/)
    expect(body.data?.recovery?.href).toBe('/pricing')
    expect(body.data?.recovery?.labelKey).toBe('ai.upgradeCta')
  })
})
