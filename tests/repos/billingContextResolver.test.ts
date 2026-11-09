import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from 'vitest'
import { resetDb, testDb } from '../integration/setup/db'
import { createUser, createWorkspace, setMemberRole } from '../integration/setup/fixtures'
import { resolveBillingContext } from '../../server/utils/billing'

// Base resolver shape:
//   - free user, no workspace → self-bill, calendar-month period
//   - active paid user → self-bill, Stripe-anchored period
//   - lapsed paid user → defensive downgrade to free caps
//   - workspace docs self-bill too (the `(+)` sponsorship is retired;
//     Team billing arrives in WP3)
//
// These were originally in `billingResolver.test.ts` (deleted with the
// pre-Phase-6 ai_usage_period table); resurrected here without the
// `interactionsRemaining` shape.

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

describe('resolveBillingContext — base shape', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('fresh free user, no workspace → free plan + user attribution + calendar-month anchor', async () => {
    const u = await createUser()
    const before = Date.now()
    const ctx = await resolveBillingContext(u.id, null)
    const after = Date.now()

    expect(ctx.plan).toBe('free')
    expect(ctx.attribution).toBe('user')
    expect(ctx.attributedTo).toBe(`user:${u.id}`)
    expect(ctx.billingUserId).toBe(u.id)
    // Calendar-month anchor: period start is the first of THIS month UTC.
    const expectedStart = new Date(Date.UTC(
      new Date().getUTCFullYear(),
      new Date().getUTCMonth(),
      1, 0, 0, 0
    ))
    expect(ctx.periodStart.toISOString()).toBe(expectedStart.toISOString())
    // periodEnd is the first of NEXT month (start of next calendar month).
    expect(ctx.periodEnd.getTime()).toBeGreaterThan(before)
    expect(ctx.periodEnd.getTime()).toBeGreaterThan(after)
  })

  it('active paid user → paid plan + Stripe-anchored period', async () => {
    const u = await createUser()
    const db = testDb()
    // Anchor: period started 5 days ago, valid for another 25 days.
    const past = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000)
    const future = new Date(Date.now() + 25 * 24 * 60 * 60 * 1000)
    await db.query(
      'UPDATE users SET plan = $1, plan_valid_until = $2, stripe_current_period_start = $3 WHERE id = $4',
      ['pro', future, past, u.id]
    )

    const ctx = await resolveBillingContext(u.id, null)
    expect(ctx.plan).toBe('pro')
    expect(ctx.attribution).toBe('user')
    // Period anchored to the Stripe values, not calendar month.
    expect(ctx.periodStart.toISOString()).toBe(past.toISOString())
    expect(ctx.periodEnd.toISOString()).toBe(future.toISOString())
  })

  it('lapsed paid user → defensive downgrade to free caps', async () => {
    const u = await createUser()
    const db = testDb()
    // Plan_valid_until in the past → resolver treats as lapsed.
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
    await db.query(
      'UPDATE users SET plan = $1, plan_valid_until = $2 WHERE id = $3',
      ['pro', yesterday, u.id]
    )

    const ctx = await resolveBillingContext(u.id, null)
    expect(ctx.plan).toBe('free')
    expect(ctx.attribution).toBe('user')
    // Lapsed user re-anchors to the calendar month (free fallback).
    const expectedStart = new Date(Date.UTC(
      new Date().getUTCFullYear(),
      new Date().getUTCMonth(),
      1, 0, 0, 0
    ))
    expect(ctx.periodStart.toISOString()).toBe(expectedStart.toISOString())
  })

  it('a workspace doc still self-bills until Team billing exists (WP3)', async () => {
    const owner = await createUser()
    const member = await createUser()
    const db = testDb()
    const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    await db.query(
      'UPDATE users SET plan = $1, plan_valid_until = $2 WHERE id = $3',
      ['pro', future, owner.id]
    )
    const ws = await createWorkspace(owner.id)
    await setMemberRole(ws.workspaceId, member.id, 'editor')
    // Even a leftover row of the retired `(+)` sponsorship changes nothing.
    await db.query(
      'UPDATE workspaces SET billing_owner_id = $1, ai_enabled = true WHERE workspace_id = $2',
      [owner.id, ws.workspaceId]
    )

    const ctx = await resolveBillingContext(member.id, ws.workspaceId)
    expect(ctx.attribution).toBe('user')
    expect(ctx.billingUserId).toBe(member.id)
    expect(ctx.plan).toBe('free')
  })

  it('throws when userId does not exist (caller is responsible for session validation)', async () => {
    // The resolver doesn't gracefully degrade on missing-user — it
    // throws so the call site doesn't accidentally bill against a
    // ghost. Every production caller goes through `requireValidatedUserSession`
    // first which 401s before the handler runs.
    await expect(resolveBillingContext(99_999_999, null)).rejects.toThrow(/not found/)
  })
})
