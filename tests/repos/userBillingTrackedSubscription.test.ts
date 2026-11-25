import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, testDb } from '../integration/setup/db'
import { createUser } from '../integration/setup/fixtures'
import { sys } from '../helpers/access'
import { endUserSubscription, findTrackedUserSubscription, listTrackedUserSubscriptions, lockTrackedSubscriptionOfUser, updateUserBilling } from '../../server/repos/userBilling'
import { withTransaction } from '../../server/db/client'

// A customer can hold two personal subscriptions (a double checkout, an
// old one support cleans up). Only the one the user row tracks ends the
// plan: cancelling the other must leave the user on Pro.

const CUSTOMER = 'cus_two_subs'
const VALID_UNTIL = new Date('2027-12-01T00:00:00.000Z')
const AT = new Date('2027-11-01T12:00:00.000Z')

interface Row { plan: string, stripe_subscription_id: string | null, stripe_customer_id: string | null, plan_valid_until: Date | null }

async function proUser(subscriptionId: string | null, plan = 'pro'): Promise<number> {
  const u = await createUser()
  await testDb().query(
    'UPDATE users SET plan = $1, stripe_customer_id = $2, stripe_subscription_id = $3, plan_valid_until = $4 WHERE id = $5',
    [plan, CUSTOMER, subscriptionId, subscriptionId ? VALID_UNTIL : null, u.id]
  )
  return u.id
}

async function read(id: number): Promise<Row | undefined> {
  return (await testDb().query<Row>('SELECT plan, stripe_subscription_id, stripe_customer_id, plan_valid_until FROM users WHERE id = $1', [id])).rows[0]
}

describe('endUserSubscription', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('a cancelled duplicate leaves the user on Pro with the tracked subscription', async () => {
    const id = await proUser('sub_tracked')
    expect(await endUserSubscription(sys(), undefined, CUSTOMER, 'sub_duplicate', AT)).toBe(0)
    expect(await read(id)).toEqual({ plan: 'pro', stripe_subscription_id: 'sub_tracked', stripe_customer_id: CUSTOMER, plan_valid_until: VALID_UNTIL })
  })

  it('the tracked subscription ends the plan; the customer stays for a later purchase', async () => {
    const id = await proUser('sub_tracked')
    expect(await endUserSubscription(sys(), undefined, CUSTOMER, 'sub_tracked', AT)).toBe(1)
    expect(await read(id)).toEqual({ plan: 'free', stripe_subscription_id: null, stripe_customer_id: CUSTOMER, plan_valid_until: null })
  })

  it('a row that tracks no subscription is not written', async () => {
    const id = await proUser(null, 'free')
    expect(await endUserSubscription(sys(), undefined, CUSTOMER, 'sub_any', AT)).toBe(0)
    const ts = (await testDb().query<{ subscription_event_at: Date | null }>('SELECT subscription_event_at FROM users WHERE id = $1', [id])).rows[0]
    expect(ts?.subscription_event_at).toBeNull()
  })

  it('an event older than the stored state ends nothing', async () => {
    const id = await proUser('sub_tracked')
    await testDb().query('UPDATE users SET subscription_event_at = $1 WHERE id = $2', [new Date(AT.getTime() + 1000), id])
    expect(await endUserSubscription(sys(), undefined, CUSTOMER, 'sub_tracked', AT)).toBe(0)
    expect((await read(id))?.plan).toBe('pro')
  })
})

describe('findTrackedUserSubscription', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('names the subscription the customer\'s row tracks, null for none or an unknown customer', async () => {
    const id = await proUser('sub_tracked')
    expect(await findTrackedUserSubscription(sys(), CUSTOMER)).toBe('sub_tracked')
    await testDb().query('UPDATE users SET stripe_subscription_id = NULL WHERE id = $1', [id])
    expect(await findTrackedUserSubscription(sys(), CUSTOMER)).toBeNull()
    expect(await findTrackedUserSubscription(sys(), 'cus_unknown')).toBeNull()
  })
})

describe('lockTrackedSubscriptionOfUser', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('reads the tracked subscription, or null when the row tracks none or is gone', async () => {
    const tracked = await proUser('sub_tracked')
    const none = (await createUser()).id
    expect(await lockTrackedSubscriptionOfUser(sys(), undefined, tracked)).toBe('sub_tracked')
    expect(await lockTrackedSubscriptionOfUser(sys(), undefined, none)).toBeNull()
    expect(await lockTrackedSubscriptionOfUser(sys(), undefined, 999_999)).toBeNull()
  })

  it('two checkouts of one user bind one after the other: the second sees what the first bound', async () => {
    const id = await proUser(null, 'free')
    let releaseFirst: () => void = () => {}
    const firstMayCommit = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let firstLocked: () => void = () => {}
    const firstHoldsLock = new Promise<void>((resolve) => {
      firstLocked = resolve
    })

    const first = withTransaction(async (tx) => {
      expect(await lockTrackedSubscriptionOfUser(sys(), tx, id)).toBeNull()
      firstLocked()
      await firstMayCommit
      await updateUserBilling(sys(), { where: { id }, set: { stripeSubscriptionId: 'sub_first' } }, tx)
    })
    await firstHoldsLock
    const second = withTransaction(async tx => lockTrackedSubscriptionOfUser(sys(), tx, id))
    // The second read waits on the first transaction's row lock.
    await new Promise(resolve => setTimeout(resolve, 100))
    releaseFirst()
    await first
    expect(await second).toBe('sub_first')
  })
})

describe('listTrackedUserSubscriptions', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('lists every user row that tracks a subscription, with what the consistency check compares', async () => {
    const tracked = await proUser('sub_listed')
    await testDb().query('UPDATE users SET billing_interval = $1, subscription_status = $2 WHERE id = $3', ['year', 'past_due', tracked])
    await proUser(null, 'free')
    expect(await listTrackedUserSubscriptions(sys())).toEqual([
      { userId: tracked, subscriptionId: 'sub_listed', customerId: CUSTOMER, plan: 'pro', interval: 'year', status: 'past_due' }
    ])
  })
})
