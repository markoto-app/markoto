import { describe, it, expect, beforeEach } from 'vitest'
import type Stripe from 'stripe'
import { resetDb, testDb } from '../integration/setup/db'
import { createUser, createWorkspace } from '../integration/setup/fixtures'
import { backfillSubscriptionCancelDates } from '../../server/utils/billing/subscriptionCancelBackfill'

// A subscription cancelled in the portal while no event reached its row
// would read "Renews on" until its next event. The backfill asks Stripe
// for every row no event has written and stores the end date, and leaves
// alone what an event wrote, what already has a date and what still renews.

const ENDS = new Date('2027-11-14T00:00:00.000Z')

function fakeStripe(subs: Record<string, Partial<Stripe.Subscription>>): { stripe: Stripe, asked: string[] } {
  const asked: string[] = []
  const stripe = {
    subscriptions: {
      retrieve: async (id: string) => {
        asked.push(id)
        const sub = subs[id]
        if (!sub) throw new Error(`no such subscription: ${id}`)
        return { cancel_at: null, cancel_at_period_end: false, items: { data: [] }, ...sub }
      }
    }
  } as unknown as Stripe
  return { stripe, asked }
}

const cancelled = { cancel_at: Math.floor(ENDS.getTime() / 1000) }

async function proUser(subscriptionId: string, set: { eventAt?: Date, cancelAt?: Date } = {}): Promise<number> {
  const u = await createUser()
  await testDb().query(
    'UPDATE users SET plan = $1, stripe_subscription_id = $2, subscription_event_at = $3, plan_cancel_at = $4 WHERE id = $5',
    ['pro', subscriptionId, set.eventAt ?? null, set.cancelAt ?? null, u.id]
  )
  return u.id
}

async function userCancelAt(userId: number): Promise<string | null> {
  const r = await testDb().query<{ plan_cancel_at: Date | null }>('SELECT plan_cancel_at FROM users WHERE id = $1', [userId])
  return r.rows[0]?.plan_cancel_at?.toISOString() ?? null
}

describe('backfillSubscriptionCancelDates', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('stores the end date of a cancelled personal subscription no event has written', async () => {
    const id = await proUser('sub_cancelled')
    const { stripe } = fakeStripe({ sub_cancelled: cancelled })
    expect(await backfillSubscriptionCancelDates(stripe)).toEqual({ checked: 1, updated: 1, failed: 0 })
    expect(await userCancelAt(id)).toBe(ENDS.toISOString())
  })

  it('leaves rows alone that an event wrote or that already hold a date, and keeps renewing ones as they are', async () => {
    const written = await proUser('sub_written', { eventAt: new Date('2027-01-01T00:00:00Z') })
    const dated = await proUser('sub_dated', { cancelAt: new Date('2027-12-01T00:00:00Z') })
    const renewing = await proUser('sub_renewing')
    const { stripe, asked } = fakeStripe({ sub_written: cancelled, sub_dated: cancelled, sub_renewing: {} })
    expect(await backfillSubscriptionCancelDates(stripe)).toEqual({ checked: 1, updated: 0, failed: 0 })
    expect(asked).toEqual(['sub_renewing'])
    expect(await userCancelAt(written)).toBeNull()
    expect(await userCancelAt(dated)).toBe('2027-12-01T00:00:00.000Z')
    expect(await userCancelAt(renewing)).toBeNull()
  })

  it('cancel at period end: the period end is the end date; workspace subscriptions too', async () => {
    const owner = await createUser()
    const ws = await createWorkspace(owner.id)
    await testDb().query(
      `INSERT INTO workspace_subscriptions (workspace_id, plan, seats, status, stripe_subscription_id)
       VALUES ($1, 'team', 3, 'active', 'sub_ws')`,
      [ws.workspaceId]
    )
    const periodEnd = Math.floor(ENDS.getTime() / 1000)
    const { stripe } = fakeStripe({
      sub_ws: { cancel_at_period_end: true, current_period_end: periodEnd, items: { data: [{ current_period_end: periodEnd }] } } as unknown as Partial<Stripe.Subscription>
    })
    expect(await backfillSubscriptionCancelDates(stripe)).toEqual({ checked: 1, updated: 1, failed: 0 })
    const r = await testDb().query<{ cancel_at: Date | null }>('SELECT cancel_at FROM workspace_subscriptions WHERE workspace_id = $1', [ws.workspaceId])
    expect(r.rows[0]?.cancel_at?.toISOString()).toBe(ENDS.toISOString())
  })

  it('a subscription Stripe does not know is counted as failed, the rest still runs', async () => {
    await proUser('sub_missing')
    const ok = await proUser('sub_ok')
    const { stripe } = fakeStripe({ sub_ok: cancelled })
    expect(await backfillSubscriptionCancelDates(stripe)).toEqual({ checked: 2, updated: 1, failed: 1 })
    expect(await userCancelAt(ok)).toBe(ENDS.toISOString())
  })

  it('without Stripe (billing off) does nothing', async () => {
    await proUser('sub_x')
    expect(await backfillSubscriptionCancelDates(null)).toEqual({ checked: 0, updated: 0, failed: 0 })
  })
})
