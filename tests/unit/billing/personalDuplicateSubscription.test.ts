import { beforeEach, describe, expect, it, vi } from 'vitest'
import { captureLogs } from '../../helpers/logs'
import { makeSubscriptionDeletedEvent, makeSubscriptionEvent } from '~~/tests/helpers/stripe'
import type { DeferredAfterCommit } from '../../../server/utils/billing/stripeEvents/types'

// A customer with two personal subscriptions (a double checkout, an old
// one support cleans up): only the one the user row tracks may change or
// end the user's plan. The row is in memory and the two repo writes keep
// the rule of their SQL (customer + tracked subscription id + event age);
// the SQL itself is pinned by `tests/repos/userBillingTrackedSubscription.test.ts`.

const CUSTOMER = 'cus_pro'
const TRACKED = 'sub_tracked'
const DUPLICATE = 'sub_duplicate'

const { row, keys, history } = vi.hoisted(() => ({
  row: {
    stripeCustomerId: 'cus_pro' as string | null,
    stripeSubscriptionId: 'sub_tracked' as string | null,
    plan: 'pro' as string,
    planCancelAt: null as Date | null,
    subscriptionEventAt: null as Date | null
  },
  keys: { updateUserKeyBudget: vi.fn(), resetUserKeySpend: vi.fn() },
  history: { recordSubscriptionEvent: vi.fn(async () => true) }
}))

function tracks(customerId: string, subscriptionId: string, at: Date): boolean {
  return row.stripeCustomerId === customerId
    && row.stripeSubscriptionId === subscriptionId
    && (row.subscriptionEventAt === null || row.subscriptionEventAt <= at)
}

vi.mock('../../../server/repos/userBilling', () => ({
  findUserIdByStripeCustomer: async (_by: unknown, customerId: string) => (row.stripeCustomerId === customerId ? 42 : null),
  findTrackedUserSubscription: async (_by: unknown, customerId: string) => (row.stripeCustomerId === customerId ? row.stripeSubscriptionId : null),
  applyUserSubscriptionState: async (_by: unknown, _tx: unknown, customerId: string, subscriptionId: string, set: { plan?: string, planCancelAt?: Date | null }, at: Date) => {
    if (!tracks(customerId, subscriptionId, at)) return 0
    Object.assign(row, set, { subscriptionEventAt: at })
    return 1
  },
  endUserSubscription: async (_by: unknown, _tx: unknown, customerId: string, subscriptionId: string, at: Date) => {
    if (!tracks(customerId, subscriptionId, at)) return 0
    Object.assign(row, { plan: 'free', stripeSubscriptionId: null, planCancelAt: null, subscriptionEventAt: at })
    return 1
  }
}))
vi.mock('../../../server/repos/subscriptionEvents', () => history)
vi.mock('../../../server/utils/litellm/userKeys', () => keys)

const { handleSubscriptionDeleted, handleSubscriptionUpdated } = await import('../../../server/utils/billing/stripeEvents/subscriptionEvents')

const logs = captureLogs()

beforeEach(() => {
  vi.stubEnv('NUXT_STRIPE_PRICE_IDS', 'markoto_pro_month_eur=price_pro_month')
  Object.assign(row, { stripeCustomerId: CUSTOMER, stripeSubscriptionId: TRACKED, plan: 'pro', planCancelAt: null, subscriptionEventAt: null })
  keys.updateUserKeyBudget.mockReset()
  keys.resetUserKeySpend.mockReset()
  history.recordSubscriptionEvent.mockClear()
})

async function runDeferred(deferred: DeferredAfterCommit): Promise<void> {
  for (const job of deferred) await job()
}

describe('customer.subscription.deleted of a personal customer', () => {
  it('a cancelled duplicate keeps the user on Pro and their AI budget', async () => {
    const deferred: DeferredAfterCommit = []
    const result = await handleSubscriptionDeleted(makeSubscriptionDeletedEvent({ subscriptionId: DUPLICATE, customer: CUSTOMER, priceId: 'price_pro_month' }), undefined, deferred)
    await runDeferred(deferred)

    expect(result).toEqual({ matched: 0 })
    expect(row).toMatchObject({ plan: 'pro', stripeSubscriptionId: TRACKED })
    expect(keys.updateUserKeyBudget).not.toHaveBeenCalled()
    expect(keys.resetUserKeySpend).not.toHaveBeenCalled()
    expect(logs.find('warn', 'ignoring event: the user is on another subscription')).toMatchObject({
      eventType: 'customer.subscription.deleted',
      subscriptionId: DUPLICATE,
      trackedSubscriptionId: TRACKED
    })
  })

  it('still records the duplicate\'s end in the history (its start was recorded too)', async () => {
    await handleSubscriptionDeleted(makeSubscriptionDeletedEvent({ subscriptionId: DUPLICATE, customer: CUSTOMER, priceId: 'price_pro_month' }))
    expect(history.recordSubscriptionEvent).toHaveBeenCalledWith(expect.anything(), undefined, expect.objectContaining({ kind: 'ended', stripeSubscriptionId: DUPLICATE, subject: { kind: 'user', userId: 42 } }))
  })

  it('the tracked subscription ends the plan and drops the budget to Free', async () => {
    const deferred: DeferredAfterCommit = []
    const result = await handleSubscriptionDeleted(makeSubscriptionDeletedEvent({ subscriptionId: TRACKED, customer: CUSTOMER, priceId: 'price_pro_month' }), undefined, deferred)
    await runDeferred(deferred)

    expect(result).toEqual({ matched: 1 })
    expect(row).toMatchObject({ plan: 'free', stripeSubscriptionId: null })
    expect(keys.updateUserKeyBudget).toHaveBeenCalledWith(42, 'free')
    expect(keys.resetUserKeySpend).toHaveBeenCalledWith(42)
  })

  it('a row that tracks no subscription is left alone (no spend reset for a Free user)', async () => {
    Object.assign(row, { plan: 'free', stripeSubscriptionId: null })
    const deferred: DeferredAfterCommit = []
    const result = await handleSubscriptionDeleted(makeSubscriptionDeletedEvent({ subscriptionId: DUPLICATE, customer: CUSTOMER }), undefined, deferred)
    await runDeferred(deferred)

    expect(result).toEqual({ matched: 0 })
    expect(keys.resetUserKeySpend).not.toHaveBeenCalled()
    expect(logs.find('warn')).toBeUndefined()
    expect(logs.find('info', 'ignoring event: the user tracks no subscription, or the stored state is newer')).toMatchObject({ subscriptionId: DUPLICATE })
  })
})

describe('customer.subscription.updated of a personal customer', () => {
  it('a duplicate scheduled to end does not move the tracked subscription\'s end date', async () => {
    const deferred: DeferredAfterCommit = []
    const event = makeSubscriptionEvent({ type: 'customer.subscription.updated', subscriptionId: DUPLICATE, customer: CUSTOMER, priceId: 'price_pro_month', cancelAtPeriodEnd: true })
    const result = await handleSubscriptionUpdated(event, { deferAfterCommit: deferred })
    await runDeferred(deferred)

    expect(result).toEqual({ matched: 0, plan: null })
    expect(row).toMatchObject({ plan: 'pro', stripeSubscriptionId: TRACKED, planCancelAt: null })
    expect(keys.updateUserKeyBudget).not.toHaveBeenCalled()
    expect(logs.find('warn', 'ignoring event: the user is on another subscription')).toMatchObject({ subscriptionId: DUPLICATE, trackedSubscriptionId: TRACKED })
  })

  it('the tracked subscription\'s update is applied', async () => {
    const deferred: DeferredAfterCommit = []
    const event = makeSubscriptionEvent({ type: 'customer.subscription.updated', subscriptionId: TRACKED, customer: CUSTOMER, priceId: 'price_pro_month', cancelAtPeriodEnd: true })
    const result = await handleSubscriptionUpdated(event, { deferAfterCommit: deferred })
    await runDeferred(deferred)

    expect(result).toEqual({ matched: 1, plan: 'pro' })
    expect(row.planCancelAt).toBeInstanceOf(Date)
    expect(keys.updateUserKeyBudget).toHaveBeenCalledWith(42, 'pro')
  })
})
