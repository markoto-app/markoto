import { describe, it, expect, beforeEach, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { resetDb, testDb } from '../integration/setup/db'
import { createUser, createWorkspace, setMemberRole } from '../integration/setup/fixtures'
import { resolveBillingContext } from '../../server/utils/billing'
import { resolveCaps } from '../../server/utils/knowledgeQuota'
import { DEFAULT_TIERS } from '../../shared/config/tiers'

// Billing OFF (the default: self-hosted + free-only SaaS). Nobody can
// buy a plan, so every account resolves to the FREE tier — even a row
// that still says `pro` (e.g. left over from a test period) — and `(+)`
// workspace sponsorship never applies. Limits are raised for everyone
// via TIER_FREE_* env vars instead.

beforeAll(() => {
  vi.stubEnv('NUXT_BILLING_ENABLED', 'false')
})
afterAll(() => {
  vi.unstubAllEnvs()
})

async function setActivePaidPlan(userId: number, plan: 'pro' | 'max' | 'ultra'): Promise<{ past: Date, future: Date }> {
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

  it('(+) sponsorship is ignored: a member of a Max-sponsored workspace self-bills at free', async () => {
    const sponsor = await createUser()
    const member = await createUser()
    await setActivePaidPlan(sponsor.id, 'max')
    const ws = await createWorkspace(sponsor.id)
    await setMemberRole(ws.workspaceId, member.id, 'editor')
    await testDb().query(
      'UPDATE workspaces SET ai_enabled = TRUE, billing_owner_id = $1 WHERE workspace_id = $2',
      [sponsor.id, ws.workspaceId]
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

  it('stored paid plans (uploader AND sponsor) still get free caps', async () => {
    const creator = await createUser()
    const sponsor = await createUser()
    await setActivePaidPlan(creator.id, 'ultra')
    await setActivePaidPlan(sponsor.id, 'max')
    const ws = await createWorkspace(creator.id)
    await testDb().query(
      'UPDATE workspaces SET ai_enabled = true, billing_owner_id = $1 WHERE workspace_id = $2',
      [sponsor.id, ws.workspaceId]
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
