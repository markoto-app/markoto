import { describe, it, expect, beforeEach } from 'vitest'
import type Stripe from 'stripe'
import { resetDb, testDb } from '../integration/setup/db'
import { createUser, createWorkspace } from '../integration/setup/fixtures'
import { asUser, wsAs } from '../helpers/access'
import { resumeRecordedSubscription, resumeUpdateParams } from '../../server/utils/billing/resumeSubscription'
import { recordOwnPlanResumed } from '../../server/repos/userBilling'
import { recordWorkspacePlanResumed } from '../../server/repos/workspaceSubscriptions'

// "Resume plan" on a cancelled plan that still runs (staging finding
// N21): the Stripe call undoes the field the cancellation set, and the
// row renews again at once, before the webhook arrives.

const ENDS = new Date('2027-11-14T00:00:00.000Z')
const AT = new Date('2027-10-01T12:00:00.000Z')

function fakeStripe(sub: Partial<Stripe.Subscription> | null, opts: { updateFails?: boolean, retrieveFails?: boolean } = {}) {
  const updates: Array<{ id: string, params: unknown }> = []
  const stripe = {
    subscriptions: {
      retrieve: async (id: string) => {
        if (opts.retrieveFails) throw new Error('network down')
        if (!sub) throw Object.assign(new Error('No such subscription'), { code: 'resource_missing' })
        return { id, status: 'active', cancel_at: null, cancel_at_period_end: false, items: { data: [] }, ...sub }
      },
      update: async (id: string, params: unknown) => {
        if (opts.updateFails) throw new Error('card declined')
        updates.push({ id, params })
        return { id }
      }
    }
  } as unknown as Stripe
  return { stripe, updates }
}

function errorCode(e: unknown): string | undefined {
  return (e as { data?: { code?: string } }).data?.code
}

describe('resumeUpdateParams', () => {
  it('undoes the field the cancellation set, nothing for a renewing plan', () => {
    expect(resumeUpdateParams({ cancel_at_period_end: true, cancel_at: 1 })).toEqual({ cancel_at_period_end: false })
    expect(resumeUpdateParams({ cancel_at_period_end: false, cancel_at: 1 })).toEqual({ cancel_at: '' })
    expect(resumeUpdateParams({ cancel_at_period_end: false, cancel_at: null })).toBeNull()
  })
})

describe('resumeRecordedSubscription', () => {
  it('resumes a subscription cancelled to the period end', async () => {
    const { stripe, updates } = fakeStripe({ cancel_at_period_end: true })
    const res = await resumeRecordedSubscription(stripe, 'sub_1', { userId: '1' })
    expect(res.resumed).toBe(true)
    expect(updates).toEqual([{ id: 'sub_1', params: { cancel_at_period_end: false } }])
  })

  it('a renewing subscription is left as it is', async () => {
    const { stripe, updates } = fakeStripe({})
    expect((await resumeRecordedSubscription(stripe, 'sub_1', {})).resumed).toBe(false)
    expect(updates).toEqual([])
  })

  it('409 billing/no-subscription once the plan has ended or was never bought', async () => {
    await expect(resumeRecordedSubscription(fakeStripe(null).stripe, 'sub_gone', {})).rejects.toSatisfy(e => errorCode(e) === 'billing/no-subscription')
    await expect(resumeRecordedSubscription(fakeStripe({ status: 'canceled' }).stripe, 'sub_1', {})).rejects.toSatisfy(e => errorCode(e) === 'billing/no-subscription')
    await expect(resumeRecordedSubscription(fakeStripe({}).stripe, null, {})).rejects.toSatisfy(e => errorCode(e) === 'billing/no-subscription')
  })

  it('a Stripe failure is reported, not swallowed', async () => {
    await expect(resumeRecordedSubscription(fakeStripe({}, { retrieveFails: true }).stripe, 'sub_1', {})).rejects.toSatisfy(e => errorCode(e) === 'billing/subscription-check-failed')
    await expect(resumeRecordedSubscription(fakeStripe({ cancel_at: 5 }, { updateFails: true }).stripe, 'sub_1', {})).rejects.toSatisfy(e => errorCode(e) === 'billing/plan-change-failed')
  })
})

describe('recording a resumed plan', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('personal: clears the end date of the subscription the row tracks, only that one', async () => {
    const u = await createUser()
    await testDb().query('UPDATE users SET plan = $1, stripe_subscription_id = $2, plan_cancel_at = $3 WHERE id = $4', ['pro', 'sub_mine', ENDS, u.id])
    await recordOwnPlanResumed(asUser(u.id), 'sub_other', AT)
    const read = async () => (await testDb().query<{ plan_cancel_at: Date | null, subscription_event_at: Date | null }>('SELECT plan_cancel_at, subscription_event_at FROM users WHERE id = $1', [u.id])).rows[0]
    expect((await read())?.plan_cancel_at?.toISOString()).toBe(ENDS.toISOString())

    await recordOwnPlanResumed(asUser(u.id), 'sub_mine', AT)
    expect(await read()).toEqual({ plan_cancel_at: null, subscription_event_at: AT })
  })

  it('workspace: clears the end date of the live subscription', async () => {
    const owner = await createUser()
    const ws = await createWorkspace(owner.id)
    await testDb().query(
      `INSERT INTO workspace_subscriptions (workspace_id, plan, seats, status, stripe_subscription_id, cancel_at)
       VALUES ($1, 'team', 3, 'active', 'sub_ws', $2)`,
      [ws.workspaceId, ENDS]
    )
    await recordWorkspacePlanResumed(wsAs(ws.workspaceId, owner.id), 'sub_ws', AT)
    const row = (await testDb().query<{ cancel_at: Date | null, subscription_event_at: Date | null }>('SELECT cancel_at, subscription_event_at FROM workspace_subscriptions WHERE workspace_id = $1', [ws.workspaceId])).rows[0]
    expect(row).toEqual({ cancel_at: null, subscription_event_at: AT })
  })
})
