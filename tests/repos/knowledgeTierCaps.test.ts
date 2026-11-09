import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest'
import { resetDb, testDb } from '../integration/setup/db'
import { createUser, createWorkspace } from '../integration/setup/fixtures'
import { resolveCaps } from '../../server/utils/knowledgeQuota'
import { DEFAULT_TIERS as TIERS } from '../../shared/config/tiers'

// Tier-aware knowledge caps. `resolveCaps` reads the workspace's
// effective plan (its Team / Business subscription, or its creator's
// personal plan when that is better — server/utils/entitlements.ts) for
// per-workspace caps, and the uploader's own plan for per-user caps.

async function setPlan(
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

async function subscribe(
  workspaceId: string,
  plan: 'team' | 'business',
  opts: { status?: string, validUntil?: Date | null, billingAdminId?: number | null } = {}
): Promise<void> {
  const validUntil = opts.validUntil === undefined ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) : opts.validUntil
  await testDb().query(
    `INSERT INTO workspace_subscriptions (workspace_id, plan, seats, status, billing_admin_id, valid_until)
     VALUES ($1, $2, 3, $3, $4, $5)`,
    [workspaceId, plan, opts.status ?? 'active', opts.billingAdminId ?? null, validUntil]
  )
}

// These cases exercise PAID-plan behaviour, which only exists with
// billing switched on (default is off — see shared/config/billingMode.ts).
// `isBillingEnabled()` reads process.env per call, so stub it for this
// file and restore afterwards (repos tests share one worker).
beforeAll(() => {
  vi.stubEnv('NUXT_BILLING_ENABLED', 'true')
})
afterAll(() => {
  vi.unstubAllEnvs()
})

describe('resolveCaps — per-uploader tier', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('free uploader sees free-tier per-user caps regardless of workspace', async () => {
    const owner = await createUser()
    await setPlan(owner.id, 'pro')
    const ws = await createWorkspace(owner.id)
    await subscribe(ws.workspaceId, 'business')
    // Uploader is a free-tier member uploading to a Business workspace.
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

  it('no subscription: the CREATOR\'s personal plan sets the per-workspace caps', async () => {
    const creator = await createUser()
    await setPlan(creator.id, 'pro')
    const ws = await createWorkspace(creator.id)

    const caps = await resolveCaps({ workspaceId: ws.workspaceId, uploaderId: creator.id })
    expect(caps.workspacePlan).toBe('pro')
    expect(caps.maxFilesPerWorkspace).toBe(TIERS.pro.knowledgeFiles)
    expect(caps.maxTotalBytesPerWorkspace).toBe(TIERS.pro.knowledgeBytesPerWorkspace)
  })

  it('an active Team subscription sets the per-workspace caps', async () => {
    const creator = await createUser()
    const ws = await createWorkspace(creator.id)
    await subscribe(ws.workspaceId, 'team')

    const caps = await resolveCaps({ workspaceId: ws.workspaceId, uploaderId: creator.id })
    expect(caps.workspacePlan).toBe('team')
    expect(caps.maxFilesPerWorkspace).toBe(TIERS.team.knowledgeFiles)
    // The uploader's own (free) plan still sets the per-user caps.
    expect(caps.uploaderPlan).toBe('free')
  })

  it('past_due keeps the plan while Stripe retries the payment', async () => {
    const creator = await createUser()
    const ws = await createWorkspace(creator.id)
    await subscribe(ws.workspaceId, 'business', { status: 'past_due' })

    const caps = await resolveCaps({ workspaceId: ws.workspaceId, uploaderId: creator.id })
    expect(caps.workspacePlan).toBe('business')
  })

  it('a canceled or unpaid subscription falls back to the creator\'s plan', async () => {
    for (const status of ['canceled', 'unpaid', 'incomplete_expired']) {
      await resetDb()
      const creator = await createUser()
      const ws = await createWorkspace(creator.id)
      await subscribe(ws.workspaceId, 'team', { status })
      const caps = await resolveCaps({ workspaceId: ws.workspaceId, uploaderId: creator.id })
      expect(caps.workspacePlan, status).toBe('free')
    }
  })

  it('an expired subscription falls back to the creator\'s plan', async () => {
    const creator = await createUser()
    await setPlan(creator.id, 'pro')
    const ws = await createWorkspace(creator.id)
    await subscribe(ws.workspaceId, 'team', { validUntil: new Date(Date.now() - 60_000) })

    const caps = await resolveCaps({ workspaceId: ws.workspaceId, uploaderId: creator.id })
    expect(caps.workspacePlan).toBe('pro')
  })

  it('a lapsed creator with no subscription lands on free', async () => {
    const creator = await createUser()
    await testDb().query(
      'UPDATE users SET plan = $1, plan_valid_until = $2 WHERE id = $3',
      ['pro', new Date(Date.now() - 24 * 60 * 60 * 1000), creator.id]
    )
    const ws = await createWorkspace(creator.id)

    const caps = await resolveCaps({ workspaceId: ws.workspaceId, uploaderId: creator.id })
    expect(caps.workspacePlan).toBe('free')
  })

  it('a leftover retired (+) sponsorship row changes nothing', async () => {
    const creator = await createUser()
    const sponsor = await createUser()
    await setPlan(sponsor.id, 'pro')
    const ws = await createWorkspace(creator.id)
    await testDb().query(
      'UPDATE workspaces SET ai_enabled = true, billing_owner_id = $1 WHERE workspace_id = $2',
      [sponsor.id, ws.workspaceId]
    )

    const caps = await resolveCaps({ workspaceId: ws.workspaceId, uploaderId: creator.id })
    expect(caps.workspacePlan).toBe('free')
  })
})
