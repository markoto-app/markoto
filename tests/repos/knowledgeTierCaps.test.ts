import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, testDb } from '../integration/setup/db'
import { createUser, createWorkspace } from '../integration/setup/fixtures'
import { resolveCaps } from '../../server/utils/knowledgeQuota'
import { TIERS } from '../../shared/config/tiers'

// Tier-aware knowledge caps. `resolveCaps` reads the workspace's
// effective plan (billing owner if (+), else creator) for per-workspace
// caps, and the uploader's own plan for per-user caps.

async function setPlan(
  userId: number,
  plan: 'free' | 'pro' | 'max' | 'ultra'
): Promise<void> {
  const db = testDb()
  const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
  await db.query(
    'UPDATE users SET plan = $1, plan_valid_until = $2 WHERE id = $3',
    [plan, plan === 'free' ? null : future, userId]
  )
}

async function enableAiBilling(workspaceId: string, billingOwnerId: number): Promise<void> {
  await testDb().query(
    'UPDATE workspaces SET ai_enabled = true, billing_owner_id = $1 WHERE workspace_id = $2',
    [billingOwnerId, workspaceId]
  )
}

describe('resolveCaps — per-uploader tier', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('free uploader sees free-tier per-user caps regardless of workspace', async () => {
    const owner = await createUser()
    await setPlan(owner.id, 'ultra')
    const ws = await createWorkspace(owner.id)
    // Uploader is a free-tier member uploading to an Ultra-owned ws.
    const uploader = await createUser()
    await setPlan(uploader.id, 'free')

    const caps = await resolveCaps({ workspaceId: ws.workspaceId, uploaderId: uploader.id })
    expect(caps.uploaderPlan).toBe('free')
    expect(caps.maxFilesPerUser).toBe(TIERS.free.knowledgeFiles)
    expect(caps.maxTotalBytesPerUser).toBe(TIERS.free.knowledgeBytesPerUser)
  })

  it('pro uploader sees pro per-user caps', async () => {
    const owner = await createUser()
    const uploader = await createUser()
    await setPlan(uploader.id, 'pro')
    const ws = await createWorkspace(owner.id)

    const caps = await resolveCaps({ workspaceId: ws.workspaceId, uploaderId: uploader.id })
    expect(caps.uploaderPlan).toBe('pro')
    expect(caps.maxFilesPerUser).toBe(TIERS.pro.knowledgeFiles)
    expect(caps.maxTotalBytesPerUser).toBe(TIERS.pro.knowledgeBytesPerUser)
  })
})

describe('resolveCaps — per-workspace tier', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('workspace without (+) uses the CREATOR\'s tier for per-workspace caps', async () => {
    const creator = await createUser()
    await setPlan(creator.id, 'max')
    const ws = await createWorkspace(creator.id)

    const caps = await resolveCaps({ workspaceId: ws.workspaceId, uploaderId: creator.id })
    expect(caps.workspacePlan).toBe('max')
    expect(caps.maxFilesPerWorkspace).toBe(TIERS.max.knowledgeFiles)
    expect(caps.maxTotalBytesPerWorkspace).toBe(TIERS.max.knowledgeBytesPerWorkspace)
  })

  it('workspace with (+) + Max billing owner: per-workspace caps follow owner\'s plan, NOT creator\'s', async () => {
    // Ensure the `(+)` redirect actually changes the effective tier
    // — not just for interactions but also for the
    // per-workspace storage cap too. A Free user's workspace with a
    // Max (+) sponsor should get Max storage.
    const creator = await createUser()
    await setPlan(creator.id, 'free')
    const sponsor = await createUser()
    await setPlan(sponsor.id, 'max')
    const ws = await createWorkspace(creator.id)
    await enableAiBilling(ws.workspaceId, sponsor.id)

    const caps = await resolveCaps({ workspaceId: ws.workspaceId, uploaderId: creator.id })
    expect(caps.workspacePlan).toBe('max')
    expect(caps.maxFilesPerWorkspace).toBe(TIERS.max.knowledgeFiles)
  })

  it('(+) with a PRO billing owner: defensive fallback to creator\'s tier', async () => {
    // Pro can't team-bill (it's a personal-only plan). If somehow
    // (+) is enabled with a Pro owner (e.g. admin UI bug or DB state
    // corruption), resolveCaps must NOT apply Pro caps to the
    // workspace — it falls back to the creator's plan.
    const creator = await createUser()
    await setPlan(creator.id, 'free')
    const sponsor = await createUser()
    await setPlan(sponsor.id, 'pro')
    const ws = await createWorkspace(creator.id)
    await enableAiBilling(ws.workspaceId, sponsor.id)

    const caps = await resolveCaps({ workspaceId: ws.workspaceId, uploaderId: creator.id })
    // Creator is free → per-workspace caps are free.
    expect(caps.workspacePlan).toBe('free')
  })

  it('lapsed sponsor defensively downgrades the workspace cap', async () => {
    const creator = await createUser()
    await setPlan(creator.id, 'free')
    const sponsor = await createUser()
    const db = testDb()
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
    await db.query(
      'UPDATE users SET plan = $1, plan_valid_until = $2 WHERE id = $3',
      ['max', yesterday, sponsor.id]
    )
    const ws = await createWorkspace(creator.id)
    await enableAiBilling(ws.workspaceId, sponsor.id)

    const caps = await resolveCaps({ workspaceId: ws.workspaceId, uploaderId: creator.id })
    // Lapsed sponsor falls out of (+) eligibility, falling back to
    // the creator (free). Prevents a lapsed Max user from continuing
    // to give their workspace Max-level storage indefinitely.
    expect(caps.workspacePlan).toBe('free')
  })
})
