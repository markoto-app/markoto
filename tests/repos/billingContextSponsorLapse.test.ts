import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest'
import { resetDb, testDb } from '../integration/setup/db'
import { createUser, createWorkspace, setMemberRole } from '../integration/setup/fixtures'
import { resolveBillingContext } from '../../server/utils/billing'

// (+) workspace cascade — sponsor plan lapses mid-session, the next
// `resolveBillingContext` call must collapse back to self-bill so the
// member's calls go on their OWN virtual key (not a stale sponsor key).
//
// The runtime resolver re-checks the sponsor's plan validity on every
// invocation; the planLapseSweep is only a belt-and-braces correction
// of the workspace row. This test pins the runtime path:
//   1. Sponsor on Max + (+) enabled → resolver returns sponsor's key.
//   2. Sponsor's `plan_valid_until` flips to the past.
//   3. Next resolve call must return the MEMBER's key, not the
//      sponsor's; attribution flips from `workspace` → `user`.

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

describe('resolveBillingContext — (+) cascade re-attribution on sponsor lapse', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('mid-session sponsor lapse: next call self-bills against the member, not the sponsor', async () => {
    const sponsor = await createUser()
    const member = await createUser()
    const db = testDb()
    const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    const past = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000)

    // Sponsor: Max + period anchor in the past + plan_valid_until in
    // the future = active.
    await db.query(
      'UPDATE users SET plan = $1, plan_valid_until = $2, stripe_current_period_start = $3 WHERE id = $4',
      ['max', future, past, sponsor.id]
    )
    const ws = await createWorkspace(sponsor.id)
    await setMemberRole(ws.workspaceId, member.id, 'editor')
    await db.query(
      'UPDATE workspaces SET ai_enabled = TRUE, billing_owner_id = $1 WHERE workspace_id = $2',
      [sponsor.id, ws.workspaceId]
    )

    // First call: sponsor active → workspace attribution.
    const before = await resolveBillingContext(member.id, ws.workspaceId)
    expect(before.attribution).toBe('workspace')
    expect(before.plan).toBe('max')
    expect(before.billingUserId).toBe(sponsor.id)
    expect(before.attributedTo).toBe(`workspace:${ws.workspaceId}`)

    // Sponsor's plan lapses (e.g. card declined, period ended without
    // renewal). The workspace row is unchanged — the resolver must
    // notice via the live `users` row read.
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
    await db.query(
      'UPDATE users SET plan_valid_until = $1 WHERE id = $2',
      [yesterday, sponsor.id]
    )

    // Second call: sponsor inactive → self-bill. The MEMBER's user-id
    // drives the virtual-key lookup now; in real prod the bearer
    // token differs from the sponsor's. (In stub mode every key is
    // the same sentinel, so we can't compare token strings — the
    // billingUserId flip is the load-bearing assertion.)
    const after = await resolveBillingContext(member.id, ws.workspaceId)
    expect(after.attribution).toBe('user')
    expect(after.plan).toBe('free')
    expect(after.billingUserId).toBe(member.id)
    expect(after.attributedTo).toBe(`user:${member.id}`)
  })

  it('downgraded sponsor (Max → Pro) collapses (+) — Pro doesn\'t support team billing', async () => {
    // (+) is gated on max/ultra. A sponsor downgrading to Pro is the
    // common Stripe lifecycle path; the resolver must follow.
    const sponsor = await createUser()
    const member = await createUser()
    const db = testDb()
    const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    const past = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000)

    await db.query(
      'UPDATE users SET plan = $1, plan_valid_until = $2, stripe_current_period_start = $3 WHERE id = $4',
      ['max', future, past, sponsor.id]
    )
    const ws = await createWorkspace(sponsor.id)
    await setMemberRole(ws.workspaceId, member.id, 'editor')
    await db.query(
      'UPDATE workspaces SET ai_enabled = TRUE, billing_owner_id = $1 WHERE workspace_id = $2',
      [sponsor.id, ws.workspaceId]
    )

    const before = await resolveBillingContext(member.id, ws.workspaceId)
    expect(before.attribution).toBe('workspace')

    // Downgrade to Pro — still active, but Pro can't sponsor.
    await db.query(
      'UPDATE users SET plan = $1 WHERE id = $2',
      ['pro', sponsor.id]
    )

    const after = await resolveBillingContext(member.id, ws.workspaceId)
    expect(after.attribution).toBe('user')
    expect(after.billingUserId).toBe(member.id)
  })

  it('sponsor-deleted workspace (billing_owner_id null) collapses immediately to self-bill', async () => {
    // Sponsor account deletion FK-set-null'd `billing_owner_id`. The
    // workspace row may still have `ai_enabled=true` until the
    // planLapseSweep clears it; the resolver must self-bill in the
    // meantime.
    const sponsor = await createUser()
    const member = await createUser()
    const db = testDb()
    const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    await db.query(
      'UPDATE users SET plan = $1, plan_valid_until = $2 WHERE id = $3',
      ['max', future, sponsor.id]
    )
    const ws = await createWorkspace(sponsor.id)
    await setMemberRole(ws.workspaceId, member.id, 'editor')
    // billing_owner_id explicitly NULL but ai_enabled still TRUE.
    await db.query(
      'UPDATE workspaces SET ai_enabled = TRUE, billing_owner_id = NULL WHERE workspace_id = $1',
      [ws.workspaceId]
    )

    const result = await resolveBillingContext(member.id, ws.workspaceId)
    expect(result.attribution).toBe('user')
    expect(result.billingUserId).toBe(member.id)
  })
})
