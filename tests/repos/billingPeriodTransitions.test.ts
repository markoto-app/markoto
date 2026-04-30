import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { resetDb, testDb } from '../integration/setup/db'
import { createUser } from '../integration/setup/fixtures'
import {
  resolveBillingContext,
  chargeInteractions,
  getInteractionsRemaining,
  currentPeriodStart
} from '../../server/utils/billing'
import { TIERS } from '../../shared/config/tiers'

// Model-C billing period transitions. These tests simulate the
// concrete scenarios that actually matter at runtime:
//
//   - Free user → first subscription: period anchor changes from
//     calendar-month to Stripe anniversary. Old period row frozen as
//     history; new period row starts at 0.
//   - Pro → Max mid-cycle (upgrade): same anniversary period; counter
//     carries; cap bumps.
//   - Max → Free via lapse: defensive resolver treats as Free
//     immediately; new period reverts to calendar-month anchor.
//   - (+) workspace: the period follows the SPONSOR, not the caller.
//
// The tests intentionally live at the repo level rather than pure
// unit because the resolver + charger talk to Postgres and we want
// to prove the `ai_usage_period` row keys flip correctly at
// transitions — not just that the helper returns the right Date.

async function setPlanAndAnchor(
  userId: number,
  plan: 'free' | 'pro' | 'max' | 'ultra',
  stripeCurrentPeriodStart: Date | null,
  planValidUntil: Date | null
): Promise<void> {
  await testDb().query(
    `UPDATE users
       SET plan = $1,
           stripe_current_period_start = $2,
           plan_valid_until = $3
     WHERE id = $4`,
    [plan, stripeCurrentPeriodStart, planValidUntil, userId]
  )
}

async function readUsedForPeriod(attributedTo: string, periodStart: Date): Promise<number> {
  const r = await testDb().query<{ used: number | null }>(
    `SELECT interactions_used AS used FROM ai_usage_period
     WHERE attributed_to = $1 AND period_start = $2 LIMIT 1`,
    [attributedTo, periodStart]
  )
  return r.rows[0]?.used ?? 0
}

describe('Model C — Free user uses calendar-month anchor', () => {
  beforeEach(async () => {
    await resetDb()
    vi.stubEnv('TEST_MODE', '')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('resolver returns calendar-month start for a free user', async () => {
    const u = await createUser()
    // New user inserted by createUser: plan defaults to 'free', no stripe anchor.
    const ctx = await resolveBillingContext(u.id, null)
    expect(ctx.plan).toBe('free')
    expect(ctx.periodStart.toISOString()).toBe(currentPeriodStart().toISOString())
    expect(ctx.periodEnd.getUTCDate()).toBe(1) // first of next month
  })

  it('charge lands on the calendar-month row', async () => {
    const u = await createUser()
    const ctx = await resolveBillingContext(u.id, null)
    await chargeInteractions({
      attributedTo: ctx.attributedTo,
      plan: ctx.plan,
      delta: 3,
      periodStart: ctx.periodStart
    })
    const used = await readUsedForPeriod(`user:${u.id}`, currentPeriodStart())
    expect(used).toBe(3)
  })
})

describe('Model C — Free → Paid: new period anchor, counter starts fresh', () => {
  beforeEach(async () => {
    await resetDb()
    vi.stubEnv('TEST_MODE', '')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('pre-subscription free charges stay on the calendar row, post-subscription paid charges land on the Stripe row', async () => {
    const u = await createUser()

    // Day 1: Free user, calendar-month period. Seed some usage.
    const calendar = currentPeriodStart()
    const ctxFree = await resolveBillingContext(u.id, null)
    expect(ctxFree.plan).toBe('free')
    await chargeInteractions({
      attributedTo: ctxFree.attributedTo, plan: ctxFree.plan, delta: 10,
      periodStart: ctxFree.periodStart
    })
    expect(await readUsedForPeriod(`user:${u.id}`, calendar)).toBe(10)

    // Day 15: subscribes to Pro. Stripe fires invoice.paid, we set
    // plan=pro + stripeCurrentPeriodStart=today + planValidUntil=+30d.
    const stripeStart = new Date('2026-04-15T00:00:00.000Z')
    const stripeEnd = new Date('2026-05-15T00:00:00.000Z')
    await setPlanAndAnchor(u.id, 'pro', stripeStart, stripeEnd)

    // Resolver now returns the Stripe anchor.
    const ctxPro = await resolveBillingContext(u.id, null)
    expect(ctxPro.plan).toBe('pro')
    expect(ctxPro.periodStart.getTime()).toBe(stripeStart.getTime())
    expect(ctxPro.periodEnd.getTime()).toBe(stripeEnd.getTime())

    // Remaining on the new Pro period = full 1500 (no charges on the
    // new row yet). The old 10 on the calendar row is abandoned —
    // it counts toward an earlier period the user no longer reads.
    expect(ctxPro.interactionsRemaining).toBe(TIERS.pro.interactionsPerMonth)

    // Charging on Pro lands on the NEW Stripe-anchored row, not the
    // calendar row. This is the critical property — without it, a
    // user who upgrades mid-month would see their Free usage carry
    // over and eat into their paid quota.
    await chargeInteractions({
      attributedTo: ctxPro.attributedTo, plan: ctxPro.plan, delta: 50,
      periodStart: ctxPro.periodStart
    })
    expect(await readUsedForPeriod(`user:${u.id}`, stripeStart)).toBe(50)
    // Old calendar row untouched (history).
    expect(await readUsedForPeriod(`user:${u.id}`, calendar)).toBe(10)
  })
})

describe('Model C — Pro → Max mid-cycle upgrade', () => {
  beforeEach(async () => {
    await resetDb()
    vi.stubEnv('TEST_MODE', '')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('same period continues; counter carries; cap bumps', async () => {
    const u = await createUser()

    // Pro subscribed Apr 15.
    const stripeStart = new Date('2026-04-15T00:00:00.000Z')
    const stripeEnd = new Date('2026-05-15T00:00:00.000Z')
    await setPlanAndAnchor(u.id, 'pro', stripeStart, stripeEnd)

    const proCtx = await resolveBillingContext(u.id, null)
    await chargeInteractions({
      attributedTo: proCtx.attributedTo, plan: proCtx.plan, delta: 200,
      periodStart: proCtx.periodStart
    })

    // User clicks "Upgrade to Max" on Apr 20. Stripe mid-cycle
    // upgrade does NOT move the cycle anchor — user stays on the
    // same Apr 15 → May 15 cycle. We set plan=max, keep stripe_start.
    await setPlanAndAnchor(u.id, 'max', stripeStart, stripeEnd)

    const maxCtx = await resolveBillingContext(u.id, null)
    // Same period anchor ↓
    expect(maxCtx.periodStart.getTime()).toBe(stripeStart.getTime())
    // New cap ↓
    expect(maxCtx.plan).toBe('max')
    // Counter carries: used 200 of 1500, now with a Max cap of 8000.
    // Remaining = 8000 - 200.
    expect(maxCtx.interactionsRemaining).toBe(TIERS.max.interactionsPerMonth - 200)

    // Next charge increments on the SAME row.
    await chargeInteractions({
      attributedTo: maxCtx.attributedTo, plan: maxCtx.plan, delta: 100,
      periodStart: maxCtx.periodStart
    })
    expect(await readUsedForPeriod(`user:${u.id}`, stripeStart)).toBe(300)
  })
})

describe('Model C — Max → Free via lapse: period reverts to calendar', () => {
  beforeEach(async () => {
    await resetDb()
    vi.stubEnv('TEST_MODE', '')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('resolver defensively uses calendar anchor when paid plan has lapsed', async () => {
    const u = await createUser()
    const stripeStart = new Date('2026-03-15T00:00:00.000Z')
    const stripeEnd = new Date('2026-04-15T00:00:00.000Z') // past

    // Simulate a lapsed Max user — Stripe anchors still set (sweep
    // hasn't cleaned yet) but planValidUntil is in the past.
    await setPlanAndAnchor(u.id, 'max', stripeStart, stripeEnd)

    const ctx = await resolveBillingContext(u.id, null)
    // Defensive downgrade → Free
    expect(ctx.plan).toBe('free')
    // Period anchor → calendar month (NOT the stale Stripe anchor).
    expect(ctx.periodStart.toISOString()).toBe(currentPeriodStart().toISOString())
    // Cap → Free.
    expect(ctx.interactionsRemaining).toBe(TIERS.free.interactionsPerMonth)
  })

  it('fresh Free-calendar row starts at 0 even if the old Stripe row had heavy usage', async () => {
    const u = await createUser()
    const stripeStart = new Date('2026-03-15T00:00:00.000Z')
    const stripeEnd = new Date('2026-04-15T00:00:00.000Z')
    // Seed the paid Stripe-period row with 5000 used (would be near Max's 8000 cap).
    await testDb().query(
      `INSERT INTO ai_usage_period (attributed_to, period_start, interactions_used)
       VALUES ($1, $2, 5000)`,
      [`user:${u.id}`, stripeStart]
    )
    await setPlanAndAnchor(u.id, 'max', stripeStart, stripeEnd) // lapsed

    const ctx = await resolveBillingContext(u.id, null)
    expect(ctx.plan).toBe('free')
    // Under Model C a lapsed user sees Free's full 100 for the CURRENT
    // calendar month — we don't carry the 5000 used from the stale
    // Stripe period into the new calendar one. This is what prevents
    // the "paid user lapses mid-month and sees 0 remaining forever"
    // bug from the previous (calendar-for-all) design.
    expect(ctx.interactionsRemaining).toBe(TIERS.free.interactionsPerMonth)
  })
})

describe('Model C — (+) workspace follows sponsor\'s period anchor', () => {
  beforeEach(async () => {
    await resetDb()
    vi.stubEnv('TEST_MODE', '')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('workspace counter is keyed on the sponsor\'s Stripe anniversary, not the caller\'s calendar', async () => {
    // This is the key test for a (+) workspace: if member A (Free,
    // calendar period) and member B (Pro, Apr-15 anniversary) both
    // call AI in the same Max-sponsored (+) workspace, they both
    // must charge the SAME row — keyed on the sponsor's period.
    // Otherwise the sponsor's pool would split into multiple rows
    // based on each member's personal calendar, and resolved
    // remaining would be nonsense.
    const memberA = await createUser()
    const _memberB = await createUser()
    const sponsor = await createUser()
    const sponsorStart = new Date('2026-04-10T00:00:00.000Z')
    const sponsorEnd = new Date('2026-05-10T00:00:00.000Z')
    await setPlanAndAnchor(sponsor.id, 'max', sponsorStart, sponsorEnd)

    // Create workspace with sponsor as billing owner.
    const db = testDb()
    const workspaceId = 'ws-period-test'
    await db.query(
      `INSERT INTO workspaces (workspace_id, owner_id, name, ai_enabled, billing_owner_id)
       VALUES ($1, $2, 'Sponsored', true, $3)`,
      [workspaceId, sponsor.id, sponsor.id]
    )
    // Member A (free) becomes a member.
    await db.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'editor')`,
      [workspaceId, memberA.id]
    )

    const ctxA = await resolveBillingContext(memberA.id, workspaceId)
    expect(ctxA.attribution).toBe('workspace')
    expect(ctxA.attributedTo).toBe(`workspace:${workspaceId}`)
    expect(ctxA.plan).toBe('max') // sponsor's plan
    // Period = sponsor's Stripe anchor, NOT member A's calendar month.
    expect(ctxA.periodStart.getTime()).toBe(sponsorStart.getTime())
    expect(ctxA.periodEnd.getTime()).toBe(sponsorEnd.getTime())

    // Charge from member A lands on the workspace row at the sponsor
    // period.
    await chargeInteractions({
      attributedTo: ctxA.attributedTo, plan: ctxA.plan, delta: 20,
      periodStart: ctxA.periodStart
    })
    const usedFromA = await getInteractionsRemaining(
      ctxA.attributedTo, ctxA.plan, ctxA.periodStart
    )
    expect(usedFromA).toBe(TIERS.max.interactionsPerMonth - 20)
  })
})
