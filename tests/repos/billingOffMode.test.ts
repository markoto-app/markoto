import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { resetDb, testDb } from '../integration/setup/db'
import { createUser, createWorkspace, setMemberRole } from '../integration/setup/fixtures'
import { resolveBillingContext } from '../../server/utils/billing/billing'
import { resolveCaps } from '../../server/utils/knowledge/knowledgeQuota'
import { DEFAULT_TIERS } from '../../shared/config/tiers'

// Billing OFF (the default: self-hosted + free-only SaaS). Nobody can
// buy a plan, so every account resolves to the FREE tier — even a row
// that still says `pro` (e.g. left over from a test period), and a
// workspace subscription row never applies. Limits are raised for
// everyone via TIER_FREE_* env vars instead.

// Stubbed per test: every stub is undone before the next one
// (`unstubEnvs` in vitest.config.ts).
beforeEach(() => {
  vi.stubEnv('NUXT_BILLING_ENABLED', 'false')
})

async function setActivePaidPlan(userId: number, plan: 'pro'): Promise<{ past: Date, future: Date }> {
  const past = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000)
  const future = new Date(Date.now() + 25 * 24 * 60 * 60 * 1000)
  await testDb().query(
    'UPDATE users SET plan = $1, plan_valid_until = $2, stripe_current_period_start = $3 WHERE id = $4',
    [plan, future, past, userId]
  )
  return { past, future }
}

describe('billing off — resolveBillingContext', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('a stored, still-valid paid plan resolves to free with a calendar-month period', async () => {
    const u = await createUser()
    const { past } = await setActivePaidPlan(u.id, 'pro')

    const ctx = await resolveBillingContext(u.id, null)
    expect(ctx.plan).toBe('free')
    expect(ctx.attribution).toBe('user')
    // Not the Stripe anchor — the free tier's calendar month.
    expect(ctx.periodStart.toISOString()).not.toBe(past.toISOString())
    expect(ctx.periodStart.getUTCDate()).toBe(1)
  })

  it('a member of a workspace with a Team subscription self-bills at free', async () => {
    const owner = await createUser()
    const member = await createUser()
    await setActivePaidPlan(owner.id, 'pro')
    const ws = await createWorkspace(owner.id)
    await setMemberRole(ws.workspaceId, member.id, 'editor')
    await testDb().query(
      `INSERT INTO workspace_subscriptions (workspace_id, plan, seats, status, valid_until)
       VALUES ($1, 'team', 3, 'active', NOW() + interval '30 days')`,
      [ws.workspaceId]
    )

    const ctx = await resolveBillingContext(member.id, ws.workspaceId)
    expect(ctx.attribution).toBe('user')
    expect(ctx.billingUserId).toBe(member.id)
    expect(ctx.plan).toBe('free')
  })
})

describe('billing off — knowledge caps', () => {
  beforeEach(async () => {
    await resetDb()
  })
  afterEach(() => {
    // Only the TIER_* overrides set inside a case; NUXT_BILLING_ENABLED
    // stays stubbed for the whole file.
    vi.stubEnv('TIER_FREE_KNOWLEDGE_FILES', '')
    vi.stubEnv('TIER_FREE_KNOWLEDGE_BYTES_PER_USER', '')
  })

  it('a stored paid plan and a workspace subscription still get free caps', async () => {
    const creator = await createUser()
    await setActivePaidPlan(creator.id, 'pro')
    const ws = await createWorkspace(creator.id)
    await testDb().query(
      `INSERT INTO workspace_subscriptions (workspace_id, plan, seats, status, valid_until)
       VALUES ($1, 'business', 3, 'active', NOW() + interval '30 days')`,
      [ws.workspaceId]
    )

    const caps = await resolveCaps({ workspaceId: ws.workspaceId, uploaderId: creator.id })
    expect(caps.uploaderPlan).toBe('free')
    expect(caps.workspacePlan).toBe('free')
    expect(caps.maxFilesPerUser).toBe(DEFAULT_TIERS.free.knowledgeFiles)
    expect(caps.maxFilesPerWorkspace).toBe(DEFAULT_TIERS.free.knowledgeFiles)
  })

  it('a self-hoster raises the free tier via TIER_FREE_* env vars', async () => {
    vi.stubEnv('TIER_FREE_KNOWLEDGE_FILES', '750')
    vi.stubEnv('TIER_FREE_KNOWLEDGE_BYTES_PER_USER', String(20 * 1024 * 1024 * 1024))
    const u = await createUser()
    const ws = await createWorkspace(u.id)

    const caps = await resolveCaps({ workspaceId: ws.workspaceId, uploaderId: u.id })
    expect(caps.uploaderPlan).toBe('free')
    expect(caps.maxFilesPerUser).toBe(750)
    expect(caps.maxTotalBytesPerUser).toBe(20 * 1024 * 1024 * 1024)
  })
})
