import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type Stripe from 'stripe'
import { SANDBOX_CONFIGURED } from './setup/env'
import { DAY_SECONDS, advanceClock, deleteClock, deliverAll, pinned, retrieveSubscription, sandboxStripe, type PinnedSubscription } from './setup/stripe'
import { PLAN_BUDGET_USD, aiCredits, expectSameInstant, post, userBilling, workspaceBilling, workspaceTeamBudgetUsd, type WorkspaceBillingView } from './setup/app'
import { buyWorkspacePlan, deliverPurchase, type WorkspacePurchase } from './setup/flows'

// Scenario e: a workspace subscription through its whole life. Every
// change is made through the app's own endpoint and asserted twice: right
// after the call, BEFORE any webhook (what the admin's billing tab shows
// next), and again after Stripe's events for it were delivered. A change
// names one thing (seats, plan or billing period) and must leave the
// other two alone.

type Sub = NonNullable<WorkspaceBillingView['subscription']>

describe.skipIf(!SANDBOX_CONFIGURED)('workspace: Team with 3 seats, through every change, to its end', () => {
  let stripe: Stripe
  let ws: WorkspacePurchase
  let checkoutPath: string

  beforeAll(async () => {
    stripe = sandboxStripe()
    ws = await buyWorkspacePlan(stripe, 'workspace', { plan: 'team', seats: 3 })
    checkoutPath = `/api/workspaces/${ws.workspaceId}/billing/checkout`
  })

  afterAll(async () => {
    if (ws) await deleteClock(stripe, ws.clockId)
  })

  async function shown(): Promise<Sub> {
    const billing = await workspaceBilling(ws.app.client, ws.workspaceId)
    expect(billing.subscription).not.toBeNull()
    return billing.subscription as Sub
  }

  /** The subscription in Stripe: always the one the workspace bought, on the expected price and quantity. */
  async function live(lookupKey: string, seats: number): Promise<PinnedSubscription> {
    const sub = await retrieveSubscription(stripe, ws.subscription.id)
    expect(sub.status).toBe('active')
    expect(sub.items.data).toHaveLength(1)
    expect(sub.items.data[0]).toMatchObject({ quantity: seats, price: { lookup_key: lookupKey } })
    return sub
  }

  /** Deliver Stripe's events for the last change. */
  async function deliverChange(): Promise<void> {
    const results = await deliverAll(await ws.feed.collect(['customer.subscription.updated']))
    expect(results.every(r => r.handled)).toBe(true)
  }

  /** One state, asserted before the webhooks and again after them. */
  async function expectShownBeforeAndAfterWebhooks(expected: Partial<Sub>, lookupKey: string, seats: number): Promise<void> {
    const sub = await live(lookupKey, seats)
    const before = await shown()
    expect(before).toMatchObject(expected)
    expectSameInstant(before.validUntil, sub.current_period_end)

    await deliverChange()
    const after = await shown()
    expect(after).toMatchObject(expected)
    expectSameInstant(after.validUntil, sub.current_period_end)
    expectSameInstant(after.currentPeriodStart, sub.current_period_start)
  }

  it('the purchase: Team, 3 seats, monthly, a pooled AI budget of 3 seats', async () => {
    const pending = await workspaceBilling(ws.app.client, ws.workspaceId)
    expect(pending.subscription).toMatchObject({ status: 'incomplete', entitled: false })

    await deliverPurchase(ws)
    const billing = await workspaceBilling(ws.app.client, ws.workspaceId)
    expect(billing.isBillingAdmin).toBe(true)
    expect(billing.subscription).toMatchObject({
      plan: 'team',
      seats: 3,
      status: 'active',
      paymentOverdue: false,
      entitled: true,
      interval: 'month',
      currency: 'eur',
      cancelAt: null,
      billingAdminId: ws.app.user.id
    })
    expectSameInstant(billing.subscription?.validUntil, ws.subscription.current_period_end)
    expect(billing.pool?.aiBudgetUsd).toBe(3 * PLAN_BUDGET_USD.team)
    expect(await workspaceTeamBudgetUsd(ws.workspaceId)).toBe(3 * PLAN_BUDGET_USD.team)

    // The admin's AI inside the workspace draws on the pool, and the
    // workspace covers them on their own billing page.
    expect(await aiCredits(ws.app.client, ws.workspaceId)).toMatchObject({ plan: 'team', attribution: 'workspace', workspace: { workspaceId: ws.workspaceId, teamBudgetUsd: 3 * PLAN_BUDGET_USD.team } })
    expect((await userBilling(ws.app.client)).coveringWorkspaces).toEqual([expect.objectContaining({ workspaceId: ws.workspaceId, plan: 'team' })])
  })

  it('seats 3 to 4 keeps the plan and the billing period', async () => {
    const change = await post(ws.app.client, `/api/workspaces/${ws.workspaceId}/billing/seats`, { seats: 4 })
    expect(change).toEqual({ status: 200, body: { seats: 4 } })
    await expectShownBeforeAndAfterWebhooks({ plan: 'team', seats: 4, interval: 'month', status: 'active', cancelAt: null }, 'markoto_team_month_eur', 4)

    // The added seat is paid pro rata, so it unlocks its share of the
    // budget window that is left: more than 3 seats' budget, at most 4.
    const budget = await workspaceTeamBudgetUsd(ws.workspaceId)
    expect(budget).toBeGreaterThan(3 * PLAN_BUDGET_USD.team)
    expect(budget).toBeLessThanOrEqual(4 * PLAN_BUDGET_USD.team)
    expect((await workspaceBilling(ws.app.client, ws.workspaceId)).pool?.aiBudgetUsd).toBe(budget)
  })

  it('Team to Business keeps the billing period and the seats', async () => {
    const change = await post(ws.app.client, checkoutPath, { plan: 'business', acceptPaidTerms: true })
    expect(change).toEqual({ status: 200, body: { updated: true, plan: 'business', interval: 'month' } })
    await expectShownBeforeAndAfterWebhooks({ plan: 'business', seats: 4, interval: 'month', status: 'active', cancelAt: null }, 'markoto_business_month_eur', 4)
    expect(await aiCredits(ws.app.client, ws.workspaceId)).toMatchObject({ plan: 'business', attribution: 'workspace' })
  })

  it('monthly to annual keeps the plan and the seats', async () => {
    const change = await post(ws.app.client, checkoutPath, { interval: 'year', acceptPaidTerms: true })
    expect(change).toEqual({ status: 200, body: { updated: true, plan: 'business', interval: 'year' } })
    await expectShownBeforeAndAfterWebhooks({ plan: 'business', seats: 4, interval: 'year', status: 'active', cancelAt: null }, 'markoto_business_year_eur', 4)
    const sub = await retrieveSubscription(stripe, ws.subscription.id)
    expect(sub.current_period_end - sub.current_period_start).toBeGreaterThanOrEqual(365 * DAY_SECONDS)
  })

  it('annual Business to Team stays annual', async () => {
    const change = await post(ws.app.client, checkoutPath, { plan: 'team', acceptPaidTerms: true })
    expect(change).toEqual({ status: 200, body: { updated: true, plan: 'team', interval: 'year' } })
    await expectShownBeforeAndAfterWebhooks({ plan: 'team', seats: 4, interval: 'year', status: 'active', cancelAt: null }, 'markoto_team_year_eur', 4)
  })

  it('the same plan and period again is refused', async () => {
    const again = await post<{ data?: { code?: string } }>(ws.app.client, checkoutPath, { plan: 'team', interval: 'year', acceptPaidTerms: true })
    expect(again.status).toBe(409)
    expect(again.body.data?.code).toBe('billing/already-on-plan')
  })

  it('cancelled to the period end: still Team, with the end date', async () => {
    const portal = await post<{ url?: string }>(ws.app.client, `/api/workspaces/${ws.workspaceId}/billing/portal`)
    expect(portal.status).toBe(200)
    expect(portal.body.url).toMatch(/^https:\/\/billing\.stripe\.com\//)

    // What "Cancel plan" in that portal does.
    const cancelled = pinned(await stripe.subscriptions.update(ws.subscription.id, { cancel_at_period_end: true }))
    await deliverChange()
    const sub = await shown()
    expect(sub).toMatchObject({ plan: 'team', seats: 4, interval: 'year', status: 'active', entitled: true })
    expectSameInstant(sub.cancelAt, cancelled.current_period_end)
    expectSameInstant(sub.validUntil, cancelled.current_period_end)
  })

  it('past the end the workspace is back on free: no plan, no pooled budget', async () => {
    const ending = await retrieveSubscription(stripe, ws.subscription.id)
    await advanceClock(stripe, ws.clockId, ending.current_period_end + 3600)
    expect((await retrieveSubscription(stripe, ws.subscription.id)).status).toBe('canceled')
    const results = await deliverAll(await ws.feed.collect(['customer.subscription.deleted']))
    expect(results.every(r => r.handled)).toBe(true)

    const billing = await workspaceBilling(ws.app.client, ws.workspaceId)
    expect(billing.subscription).toMatchObject({ status: 'canceled', entitled: false })
    expect(billing.pool?.aiSpendUsd).toBeNull()

    // The admin's AI is their own again, on their personal (free) budget.
    expect(await aiCredits(ws.app.client, ws.workspaceId)).toMatchObject({
      plan: 'free',
      attribution: 'user',
      workspace: null,
      pointsTotal: PLAN_BUDGET_USD.free * 1000
    })
    expect((await userBilling(ws.app.client)).coveringWorkspaces).toEqual([])
  })
})
