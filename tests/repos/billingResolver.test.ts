import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, testDb } from '../integration/setup/db'
import { createUser, createWorkspace } from '../integration/setup/fixtures'
import {
  resolveBillingContext,
  getInteractionsRemaining,
  currentPeriodStart
} from '../../server/utils/billing'
import { TIERS } from '../../shared/config/tiers'

// Helpers to manipulate billing-related schema columns that the
// fixtures don't know about yet. `setUserPlan` mirrors what the
// Stripe webhook would land: paid tiers get a future
// `plan_valid_until` + a concrete `stripe_current_period_start`.
// Callers can override either to simulate lapsed / mid-stripe-setup
// states.
async function setUserPlan(
  userId: number,
  plan: 'free' | 'pro' | 'max' | 'ultra',
  planValidUntil: Date | null = plan === 'free'
    ? null
    : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  stripeCurrentPeriodStart: Date | null = plan === 'free'
    ? null
    : new Date(Date.now() - 5 * 24 * 60 * 60 * 1000)
): Promise<void> {
  const db = testDb()
  await db.query(
    `UPDATE users SET plan = $1, plan_valid_until = $2, stripe_current_period_start = $3
     WHERE id = $4`,
    [plan, planValidUntil, stripeCurrentPeriodStart, userId]
  )
}

async function setWorkspaceBilling(
  workspaceId: string,
  aiEnabled: boolean,
  billingOwnerId: number | null
): Promise<void> {
  const db = testDb()
  await db.query(
    'UPDATE workspaces SET ai_enabled = $1, billing_owner_id = $2 WHERE workspace_id = $3',
    [aiEnabled, billingOwnerId, workspaceId]
  )
}

async function seedUsage(
  attributedTo: string,
  periodStart: Date,
  used: number
): Promise<void> {
  const db = testDb()
  await db.query(
    `INSERT INTO ai_usage_period (attributed_to, period_start, interactions_used)
     VALUES ($1, $2, $3)`,
    [attributedTo, periodStart, used]
  )
}

describe('getInteractionsRemaining', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('returns the full cap when no period row exists', async () => {
    const remaining = await getInteractionsRemaining('user:42', 'pro')
    expect(remaining).toBe(TIERS.pro.interactionsPerMonth)
  })

  it('subtracts used interactions from the cap for the right period', async () => {
    const period = currentPeriodStart()
    await seedUsage('user:42', period, 25)
    const remaining = await getInteractionsRemaining('user:42', 'pro', period)
    expect(remaining).toBe(TIERS.pro.interactionsPerMonth - 25)
  })

  it('clamps to 0 when usage equals or exceeds cap (no negatives)', async () => {
    const period = currentPeriodStart()
    await seedUsage('user:42', period, TIERS.free.interactionsPerMonth + 50)
    const remaining = await getInteractionsRemaining('user:42', 'free', period)
    expect(remaining).toBe(0)
  })

  it('uses period as part of the key — last-month usage does not count against this month', async () => {
    // Seed the APRIL row; query for MAY. The May query must see 0
    // used, not 50. If this breaks, someone turned the composite-key
    // read into an attributed_to-only read and every user's usage
    // accumulates forever.
    const may = new Date(Date.UTC(2026, 4, 1))
    const april = new Date(Date.UTC(2026, 3, 1))
    await seedUsage('user:42', april, 50)
    const remaining = await getInteractionsRemaining('user:42', 'pro', may)
    expect(remaining).toBe(TIERS.pro.interactionsPerMonth)
  })
})

describe('resolveBillingContext — self-billing branches', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('no workspace → bills the caller at the caller\'s plan', async () => {
    const u = await createUser()
    await setUserPlan(u.id, 'pro')
    const ctx = await resolveBillingContext(u.id, null)
    expect(ctx.attributedTo).toBe(`user:${u.id}`)
    expect(ctx.plan).toBe('pro')
    expect(ctx.attribution).toBe('user')
    expect(ctx.interactionsRemaining).toBe(TIERS.pro.interactionsPerMonth)
  })

  it('throws when the user row is missing', async () => {
    // Callers reach this only after `requireValidatedUserSession`
    // confirms the user exists, so a missing row is a programming
    // error — fail loudly rather than silently returning a Free
    // context for a nonexistent user.
    await expect(resolveBillingContext(99999, null)).rejects.toThrow(/not found/)
  })

  it('caller with a lapsed paid plan is downgraded to free until sweep runs', async () => {
    // Paid plans with an expired planValidUntil revert to free-tier
    // caps on the fly. This is defense-in-depth against the plan-lapse
    // sweep being slow to flip `plan` back to 'free' — we don't want
    // a Pro user still getting Pro caps for days after their
    // subscription ended.
    const u = await createUser()
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
    await setUserPlan(u.id, 'pro', yesterday)
    const ctx = await resolveBillingContext(u.id, null)
    expect(ctx.plan).toBe('free')
    expect(ctx.interactionsRemaining).toBe(TIERS.free.interactionsPerMonth)
  })

  it('active paid plan (planValidUntil in future) keeps its tier', async () => {
    const u = await createUser()
    const nextMonth = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    await setUserPlan(u.id, 'max', nextMonth)
    const ctx = await resolveBillingContext(u.id, null)
    expect(ctx.plan).toBe('max')
  })

  it('missing workspace id → self-bill (resolver does not 404)', async () => {
    // An AI call with a stale workspaceId (workspace since deleted)
    // must still let the user use their personal plan.
    const u = await createUser()
    await setUserPlan(u.id, 'pro')
    const ctx = await resolveBillingContext(u.id, 'ws-does-not-exist')
    expect(ctx.attribution).toBe('user')
    expect(ctx.plan).toBe('pro')
  })
})

describe('resolveBillingContext — (+) workspace branches', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('workspace with ai_enabled=false → self-bill even if billing_owner_id is set', async () => {
    // The toggle is BOOLEAN + owner. The plan-lapse sweep flips the boolean
    // to false on lapse; we must respect the boolean even when the
    // FK still points somewhere.
    const caller = await createUser()
    const owner = await createUser()
    await setUserPlan(owner.id, 'max', new Date(Date.now() + 1e10))
    const ws = await createWorkspace(owner.id)
    await setWorkspaceBilling(ws.workspaceId, false, owner.id)

    const ctx = await resolveBillingContext(caller.id, ws.workspaceId)
    expect(ctx.attribution).toBe('user')
    expect(ctx.attributedTo).toBe(`user:${caller.id}`)
  })

  it('(+) active with a MAX owner → bills the workspace at max caps', async () => {
    const caller = await createUser()
    const owner = await createUser()
    await setUserPlan(caller.id, 'free')
    await setUserPlan(owner.id, 'max', new Date(Date.now() + 1e10))
    const ws = await createWorkspace(owner.id)
    await setWorkspaceBilling(ws.workspaceId, true, owner.id)

    const ctx = await resolveBillingContext(caller.id, ws.workspaceId)
    expect(ctx.attribution).toBe('workspace')
    expect(ctx.attributedTo).toBe(`workspace:${ws.workspaceId}`)
    expect(ctx.plan).toBe('max')
    expect(ctx.interactionsRemaining).toBe(TIERS.max.interactionsPerMonth)
  })

  it('(+) active with an ULTRA owner → bills at ultra caps', async () => {
    const caller = await createUser()
    const owner = await createUser()
    await setUserPlan(owner.id, 'ultra', new Date(Date.now() + 1e10))
    const ws = await createWorkspace(owner.id)
    await setWorkspaceBilling(ws.workspaceId, true, owner.id)

    const ctx = await resolveBillingContext(caller.id, ws.workspaceId)
    expect(ctx.plan).toBe('ultra')
    expect(ctx.attribution).toBe('workspace')
  })

  it('(+) with a PRO owner → safety fallback to self-bill (pro cannot team-bill)', async () => {
    // Pro is personal-only by design. If a DB state somehow flags
    // `(+)` on a Pro-owned workspace, the resolver must REFUSE to
    // charge the pro owner and fall back to the caller. This is the
    // defense for "a Pro user toggling (+) via an admin UI bug".
    const caller = await createUser()
    const owner = await createUser()
    await setUserPlan(caller.id, 'free')
    await setUserPlan(owner.id, 'pro', new Date(Date.now() + 1e10))
    const ws = await createWorkspace(owner.id)
    await setWorkspaceBilling(ws.workspaceId, true, owner.id)

    const ctx = await resolveBillingContext(caller.id, ws.workspaceId)
    expect(ctx.attribution).toBe('user')
    expect(ctx.attributedTo).toBe(`user:${caller.id}`)
    expect(ctx.plan).toBe('free')
  })

  it('(+) with a LAPSED Max owner → safety fallback to self-bill', async () => {
    // Exactly the scenario the plan-lapse sweep exists to catch, but
    // before the sweep has run. We must NOT burn the lapsed owner's
    // stale pool (which has no corresponding paid subscription to
    // cover the cost).
    const caller = await createUser()
    const owner = await createUser()
    await setUserPlan(caller.id, 'pro', new Date(Date.now() + 1e10))
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
    await setUserPlan(owner.id, 'max', yesterday)
    const ws = await createWorkspace(owner.id)
    await setWorkspaceBilling(ws.workspaceId, true, owner.id)

    const ctx = await resolveBillingContext(caller.id, ws.workspaceId)
    expect(ctx.attribution).toBe('user')
    expect(ctx.attributedTo).toBe(`user:${caller.id}`)
    expect(ctx.plan).toBe('pro')
  })

  it('(+) active with billing_owner_id set to a deleted user → self-bill (FK set null)', async () => {
    // A separate billing-owner user who then deletes their account.
    // workspaces.owner_id is NOT set-null (workspaces.billing_owner_id
    // IS), so the workspace creator can't be deleted while the
    // workspace exists. The (+) billing owner is often a separate
    // user anyway — Max/Ultra subscriber designated as billing target
    // for a workspace they may not own. That's what we simulate here.
    const caller = await createUser()
    const workspaceCreator = await createUser() // stays around
    const billingOwner = await createUser()
    await setUserPlan(billingOwner.id, 'max', new Date(Date.now() + 1e10))
    const ws = await createWorkspace(workspaceCreator.id)
    await setWorkspaceBilling(ws.workspaceId, true, billingOwner.id)

    // Delete JUST the billing owner. FK SET NULL nulls billing_owner_id;
    // ai_enabled stays true until the plan-lapse sweep.
    const db = testDb()
    await db.query('DELETE FROM users WHERE id = $1', [billingOwner.id])

    const ctx = await resolveBillingContext(caller.id, ws.workspaceId)
    expect(ctx.attribution).toBe('user')
    expect(ctx.attributedTo).toBe(`user:${caller.id}`)
  })

  it('(+) correctly reads usage for the WORKSPACE key, not the caller key', async () => {
    // Seed usage against both keys; resolver must pick up the
    // workspace key's counter when in (+) mode, keyed on the
    // SPONSOR's Stripe anniversary (not the caller's calendar
    // month).
    const caller = await createUser()
    const owner = await createUser()
    await setUserPlan(caller.id, 'free')
    // Sponsor on a clearly non-calendar anchor (10 days ago →
    // 20 days from now) so we can tell calendar vs Stripe reads
    // apart.
    const sponsorPeriodStart = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
    const sponsorPeriodEnd = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000)
    await setUserPlan(owner.id, 'max', sponsorPeriodEnd, sponsorPeriodStart)
    const ws = await createWorkspace(owner.id)
    await setWorkspaceBilling(ws.workspaceId, true, owner.id)

    // Decoy on the caller's calendar month — should NOT be read.
    await seedUsage(`user:${caller.id}`, currentPeriodStart(), 500)
    // Real counter on the sponsor's Stripe anchor.
    await seedUsage(`workspace:${ws.workspaceId}`, sponsorPeriodStart, 200)

    const ctx = await resolveBillingContext(caller.id, ws.workspaceId)
    expect(ctx.interactionsRemaining).toBe(TIERS.max.interactionsPerMonth - 200)
  })
})

// ─── Adversarial: caller IS the (+) workspace's sponsor ──────────────────
//
// Edge case the existing matrix doesn't cover: what if the user
// resolving billing IS the workspace's billing owner? The semantic of
// (+) is "everyone in the workspace draws from the sponsor's pool" —
// including the sponsor themselves. So a Max owner who toggles (+) on
// their own workspace should bill the WORKSPACE pool, not their
// personal user pool, when calling AI from inside that workspace.
//
// Why this matters: if the resolver short-circuited "caller == sponsor
// → bill the user pool", the sponsor's personal use would NOT count
// against the team budget — defeating the point of the team-billing
// feature for solo Max users who occasionally invite collaborators.

describe('resolveBillingContext — caller IS the (+) sponsor', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('Max sponsor calling AI in their own (+) workspace → bills the WORKSPACE pool', async () => {
    const owner = await createUser()
    const sponsorPeriodStart = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
    const sponsorPeriodEnd = new Date(Date.now() + 27 * 24 * 60 * 60 * 1000)
    await setUserPlan(owner.id, 'max', sponsorPeriodEnd, sponsorPeriodStart)
    const ws = await createWorkspace(owner.id)
    await setWorkspaceBilling(ws.workspaceId, true, owner.id)

    const ctx = await resolveBillingContext(owner.id, ws.workspaceId)

    // The sponsor calling in their own (+) workspace bills the
    // workspace pool — not the personal one. Otherwise (+) wouldn't
    // actually pool the owner's usage with the team's.
    expect(ctx.attribution).toBe('workspace')
    expect(ctx.attributedTo).toBe(`workspace:${ws.workspaceId}`)
    expect(ctx.plan).toBe('max')
    // Period anchored on sponsor's (i.e. their own) Stripe cycle.
    expect(ctx.periodStart.toISOString()).toBe(sponsorPeriodStart.toISOString())
  })

  it('seeded usage on the user-key is IGNORED when resolving as the sponsor in (+)', async () => {
    // Decoy: a stale usage row keyed on `user:owner.id` from before
    // (+) was enabled. The resolver must NOT subtract that from the
    // workspace remaining count.
    const owner = await createUser()
    const periodStart = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
    const periodEnd = new Date(Date.now() + 27 * 24 * 60 * 60 * 1000)
    await setUserPlan(owner.id, 'max', periodEnd, periodStart)
    const ws = await createWorkspace(owner.id)
    await setWorkspaceBilling(ws.workspaceId, true, owner.id)

    // 1000 interactions on the user pool — should be invisible.
    await seedUsage(`user:${owner.id}`, currentPeriodStart(), 1000)
    // 50 on the workspace pool — should be the only usage that
    // counts.
    await seedUsage(`workspace:${ws.workspaceId}`, periodStart, 50)

    const ctx = await resolveBillingContext(owner.id, ws.workspaceId)
    expect(ctx.interactionsRemaining).toBe(TIERS.max.interactionsPerMonth - 50)
  })

  it('Max sponsor calling AI OUTSIDE the (+) workspace (no workspaceId) → bills the USER pool', async () => {
    // Symmetric pin: the sponsor isn't always on the team pool — only
    // when they're calling FROM that workspace's context. A doc-less
    // call (workspaceId=null) bills personal.
    const owner = await createUser()
    const periodStart = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
    const periodEnd = new Date(Date.now() + 27 * 24 * 60 * 60 * 1000)
    await setUserPlan(owner.id, 'max', periodEnd, periodStart)
    const ws = await createWorkspace(owner.id)
    await setWorkspaceBilling(ws.workspaceId, true, owner.id)

    await seedUsage(`user:${owner.id}`, periodStart, 75)
    await seedUsage(`workspace:${ws.workspaceId}`, periodStart, 1000)

    // No workspaceId → resolver doesn't even look at the workspace's
    // (+) state; bills personal at the user's plan.
    const ctx = await resolveBillingContext(owner.id, null)
    expect(ctx.attribution).toBe('user')
    expect(ctx.attributedTo).toBe(`user:${owner.id}`)
    expect(ctx.interactionsRemaining).toBe(TIERS.max.interactionsPerMonth - 75)
  })
})
