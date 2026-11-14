import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type Stripe from 'stripe'
import { SANDBOX_CONFIGURED } from './setup/env'
import { deleteClock, deleteCustomer, deliver, deliverAll, retrieveSubscription, sandboxStripe, shuffled, type PinnedSubscription, type SubstituteEvent } from './setup/stripe'
import { PLAN_BUDGET_USD, aiCredits, isoUnix, post, userBilling, userKeyBudgetUsd, userRow, workspaceBilling } from './setup/app'
import { buyPro, buyWorkspacePlan, deliverPurchase, type ProPurchase, type WorkspacePurchase } from './setup/flows'

// Scenario h: Stripe promises neither the order of its deliveries nor
// that each arrives once. The events of scenario a (free to Pro monthly,
// then monthly to annual) are delivered in order, in another order, and
// twice; the account has to end in the same state every time.

type AnyEvent = Stripe.Event | SubstituteEvent

interface EndState {
  plan: string
  interval: string | null
  cancelAt: string | null
  /** Seconds between the period end the app shows and the one Stripe has: 0 when right. */
  periodEndOffBy: number
  pointsTotal: number
  keyBudgetUsd: number | null
  subscriptionTracked: boolean
}

const RIGHT: EndState = {
  plan: 'pro',
  interval: 'year',
  cancelAt: null,
  periodEndOffBy: 0,
  pointsTotal: PLAN_BUDGET_USD.pro * 1000,
  keyBudgetUsd: PLAN_BUDGET_USD.pro,
  subscriptionTracked: true
}

describe.skipIf(!SANDBOX_CONFIGURED)('webhook deliveries out of order and repeated: free to Pro monthly to annual', () => {
  let stripe: Stripe
  const purchases: ProPurchase[] = []

  beforeAll(() => {
    stripe = sandboxStripe()
  })

  afterAll(async () => {
    for (const p of purchases) await deleteCustomer(stripe, p.customer.id)
  })

  async function endState(pro: ProPurchase, live: PinnedSubscription): Promise<EndState> {
    const billing = await userBilling(pro.app.client)
    return {
      plan: billing.plan,
      interval: billing.interval,
      cancelAt: billing.cancelAt,
      periodEndOffBy: (isoUnix(billing.periodEnd) as number) - live.current_period_end,
      pointsTotal: (await aiCredits(pro.app.client)).pointsTotal,
      keyBudgetUsd: await userKeyBudgetUsd(pro.app.user.id),
      subscriptionTracked: (await userRow(pro.app.user.id)).stripe_subscription_id === pro.subscription.id
    }
  }

  /**
   * Scenario a's two steps with every delivery held back: the purchase,
   * then the switch to annual billing. The switch needs the app to know
   * the subscription, so the checkout completion alone is delivered
   * between the two (it reads the live subscription itself). Returns the
   * real events of both steps in the order Stripe produced them.
   */
  async function purchaseAndSwitch(label: string): Promise<{ pro: ProPurchase, checkout: AnyEvent, real: Stripe.Event[], live: PinnedSubscription }> {
    const pro = await buyPro(stripe, label)
    purchases.push(pro)
    const checkout = pro.purchaseEvents.at(-1) as AnyEvent
    const purchase = pro.purchaseEvents.slice(0, -1) as Stripe.Event[]
    expect(await deliver(checkout)).toMatchObject({ handled: true })

    const change = await post(pro.app.client, '/api/billing/checkout', { plan: 'pro', interval: 'year', acceptPaidTerms: true })
    expect(change.status).toBe(200)
    const switchEvents = await pro.feed.collect(['customer.subscription.updated', 'invoice.paid'])
    return { pro, checkout, real: [...purchase, ...switchEvents], live: await retrieveSubscription(stripe, pro.subscription.id) }
  }

  it('in the order Stripe produced them (the reference)', async () => {
    const { pro, real, live } = await purchaseAndSwitch('order-ref')
    await deliverAll(real)
    expect(await endState(pro, live)).toEqual(RIGHT)
  })

  it('every event twice: the repeats are recognised and change nothing', async () => {
    const { pro, checkout, real, live } = await purchaseAndSwitch('order-twice')
    const first = await deliverAll(real)
    expect(first.some(r => r.replayed)).toBe(false)
    const second = await deliverAll([checkout, ...real])
    expect(second.every(r => r.replayed === true)).toBe(true)
    expect(await endState(pro, live)).toEqual(RIGHT)
  })

  it('shuffled across the invoice, payment and subscription events: the end state is the same', async () => {
    const { pro, real, live } = await purchaseAndSwitch('order-shuffled')
    // Any order, except that the subscription's own events keep theirs
    // (the test below is about those).
    const subscriptionEvents = real.filter(isSubscriptionEvent)
    const order = shuffled(real, 20261114).map(event => isSubscriptionEvent(event) ? subscriptionEvents.shift() as Stripe.Event : event)
    expect(order.map(e => e.id)).not.toEqual(real.map(e => e.id))
    await deliverAll(order)
    expect(await endState(pro, live)).toEqual(RIGHT)
  })

  // KNOWN BUG, kept as a failing expectation until it is fixed: a
  // `customer.subscription.created|updated` event is applied as the
  // subscription's state whatever its age, so an OLDER one delivered after
  // a newer one puts the old state back. Here the monthly `created` event
  // arrives after the annual `updated`: the account then shows monthly
  // billing and the monthly period end (about 11 months early), and would
  // drop to Free at that date while Stripe bills the annual plan. Stripe
  // redelivers an event the endpoint failed to acknowledge (a deploy, a
  // timeout) for up to three days, so later events can overtake it. The
  // handlers (`stripeEvents/subscriptionEvents.ts`) need to ignore a
  // snapshot older than the state they hold, or read the live subscription.
  it.fails('a subscription event older than the one already applied does not put the old state back', async () => {
    const { pro, real, live } = await purchaseAndSwitch('order-reversed')
    await deliverAll([...real].reverse())
    expect(await endState(pro, live)).toEqual(RIGHT)
  })
})

function isSubscriptionEvent(event: Stripe.Event): boolean {
  return event.type.startsWith('customer.subscription.')
}

describe.skipIf(!SANDBOX_CONFIGURED)('webhook deliveries out of order: a workspace subscription', () => {
  let stripe: Stripe
  let ws: WorkspacePurchase

  beforeAll(async () => {
    stripe = sandboxStripe()
    ws = await buyWorkspacePlan(stripe, 'order-workspace', { plan: 'team', seats: 3 })
    await deliverPurchase(ws)
  })

  afterAll(async () => {
    if (ws) await deleteClock(stripe, ws.clockId)
  })

  // The same KNOWN BUG on the workspace side: the events of the Team to
  // Business change are held back (a failed delivery Stripe retries later)
  // while the switch to annual billing goes through, then arrive. The
  // older snapshot (Business, MONTHLY) overwrites the row.
  it.fails('an older subscription event delivered late does not undo a newer change', async () => {
    const path = `/api/workspaces/${ws.workspaceId}/billing/checkout`
    expect((await post(ws.app.client, path, { plan: 'business', acceptPaidTerms: true })).status).toBe(200)
    const heldBack = await ws.feed.collect(['customer.subscription.updated'])
    expect((await post(ws.app.client, path, { interval: 'year', acceptPaidTerms: true })).status).toBe(200)
    await deliverAll(await ws.feed.collect(['customer.subscription.updated']))

    const live = await retrieveSubscription(stripe, ws.subscription.id)
    const right = { plan: 'business', interval: 'year', seats: 3, validUntil: new Date(live.current_period_end * 1000).toISOString() }
    expect((await workspaceBilling(ws.app.client, ws.workspaceId)).subscription).toMatchObject(right)

    await deliverAll(heldBack)
    expect((await workspaceBilling(ws.app.client, ws.workspaceId)).subscription).toMatchObject(right)
  })
})
