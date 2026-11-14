import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { H3Event } from 'h3'
import type Stripe from 'stripe'
import { partial } from '../../helpers/fixtures'
import { asUser, wsAs } from '../../helpers/access'
import type { WorkspaceSubscriptionFromStripe, WorkspaceSubscriptionRow } from '../../../server/repos/workspaceSubscriptions'
import type { UserBillingUpdate } from '../../../server/repos/userBilling'

// Every change request against every state of a personal and of a
// workspace subscription, one rule: A REQUEST CHANGES ONLY WHAT IT NAMES.
//
// The requests go through the functions that carry them in production
// (`startProCheckout`, `startWorkspaceCheckout`, `changeWorkspaceSeats`,
// `cancelWorkspaceSubscriptionAtPeriodEnd`, and for what the Stripe portal
// does, the webhook's `handleSubscriptionUpdated`). Stripe is an in-memory
// subscription that changes exactly what an update call names, like the
// real API; the database is one in-memory row per subject. After each
// request three things have to hold the expected state:
//
//   1. Stripe's subscription,
//   2. the local row right after the request (what the page shows next),
//   3. the local row after the webhook for the change.
//
// The real Stripe side of the same rule is the billing-sandbox tier.

type Interval = 'month' | 'year'
type Plan = 'pro' | 'team' | 'business'

/** What a subscription sells and whether it ends: the four things a request can name. */
interface State {
  plan: Plan
  interval: Interval
  seats: number
  /** Cancelled to the period end. */
  ending: boolean
}

const DAY_S = 24 * 3600
const NOW_S = Math.floor(Date.now() / 1000)
const SUB_ID = 'sub_live'
const USER_ID = 42
const USER_CUSTOMER = 'cus_user'
const WS_ID = 'ws_table'
const WS_CUSTOMER = 'cus_workspace'

const priceIdOf = (plan: Plan, interval: Interval) => `price_${plan}_${interval}`
const PRICE_IDS = (['pro', 'team', 'business'] as const)
  .flatMap(plan => (['month', 'year'] as const).flatMap(interval => (['eur', 'chf'] as const)
    .map(currency => `markoto_${plan}_${interval}_${currency}=${currency === 'eur' ? priceIdOf(plan, interval) : `price_${plan}_${interval}_chf`}`)))
  .join(',')

function identityOfPrice(priceId: string): { plan: Plan, interval: Interval } {
  const [, plan, interval] = priceId.split('_')
  return { plan: plan as Plan, interval: interval as Interval }
}

// ── Stripe, in memory ────────────────────────────────────────────────

const stripeState = { customer: USER_CUSTOMER, priceId: '', quantity: 1, ending: false, updates: 0 }

function periodEnd(interval: Interval): number {
  return NOW_S + (interval === 'year' ? 365 : 30) * DAY_S
}

function stripeSubscription(): Stripe.Subscription {
  const { interval } = identityOfPrice(stripeState.priceId)
  return partial<Stripe.Subscription>({
    id: SUB_ID,
    status: 'active',
    customer: stripeState.customer,
    cancel_at: null,
    cancel_at_period_end: stripeState.ending,
    items: partial<Stripe.Subscription['items']>({
      data: [partial<Stripe.SubscriptionItem>({
        id: 'si_1',
        quantity: stripeState.quantity,
        price: partial<Stripe.Price>({ id: stripeState.priceId, lookup_key: null }),
        current_period_start: NOW_S,
        current_period_end: periodEnd(interval)
      })]
    })
  })
}

/** Like the API: an update changes the parameters it carries and nothing else. */
const fakeStripe = partial<Stripe>({
  subscriptions: partial<Stripe['subscriptions']>({
    retrieve: (async () => stripeSubscription()) as unknown as Stripe['subscriptions']['retrieve'],
    update: (async (_id: string, params: Stripe.SubscriptionUpdateParams) => {
      stripeState.updates++
      const item = params.items?.[0]
      if (item?.price) stripeState.priceId = item.price
      if (item?.quantity !== undefined) stripeState.quantity = item.quantity
      if (params.cancel_at_period_end !== undefined) stripeState.ending = params.cancel_at_period_end
      return stripeSubscription()
    }) as unknown as Stripe['subscriptions']['update']
  }),
  prices: partial<Stripe['prices']>({
    list: (async () => ({ data: [] })) as unknown as Stripe['prices']['list']
  })
})

function stateInStripe(): State {
  return { ...identityOfPrice(stripeState.priceId), seats: stripeState.quantity, ending: stripeState.ending }
}

// ── The database, in memory ──────────────────────────────────────────

const { userRow, workspaceRow } = vi.hoisted(() => ({
  userRow: { plan: 'pro', billingInterval: 'month' as string | null, planCancelAt: null as Date | null, planValidUntil: null as Date | null },
  workspaceRow: { current: null as unknown }
}))

function workspaceRowNow(): WorkspaceSubscriptionRow {
  return workspaceRow.current as WorkspaceSubscriptionRow
}

vi.mock('../../../server/repos/userBilling', async orig => ({
  ...(await orig<typeof import('../../../server/repos/userBilling')>()),
  getUserCheckoutBilling: async () => ({ email: 'maya@example.com', stripeCustomerId: 'cus_user', stripeSubscriptionId: 'sub_live', billingCurrency: 'eur' }),
  findUserIdByStripeCustomer: async (_by: unknown, customerId: string) => customerId === 'cus_user' ? 42 : null,
  recordOwnPlanChange: async (_self: unknown, _sub: string, change: { interval: string, cancelAt: Date | null, period: { end: Date } | null }) => {
    userRow.billingInterval = change.interval
    userRow.planCancelAt = change.cancelAt
    if (change.period) userRow.planValidUntil = change.period.end
  },
  applyUserSubscriptionState: async (_by: unknown, _tx: unknown, _customer: string, _sub: string, set: UserBillingUpdate['set']) => {
    Object.assign(userRow, set)
    return 1
  }
}))

vi.mock('../../../server/repos/workspaceSubscriptions', async orig => ({
  ...(await orig<typeof import('../../../server/repos/workspaceSubscriptions')>()),
  getWorkspaceSubscription: async () => workspaceRow.current,
  getWorkspaceSubscriptionIn: async () => workspaceRow.current,
  getWorkspaceSubscriptionState: async () => ({ id: 'sub_live', status: 'active' }),
  findWorkspaceIdByStripeCustomer: async (_by: unknown, customerId: string) => customerId === 'cus_workspace' ? 'ws_table' : null,
  recordWorkspacePlanChange: async (_ws: unknown, change: { plan: string, interval: string, cancelAt: Date | null, period: { start: Date, end: Date } | null }) => {
    Object.assign(workspaceRow.current as object, { plan: change.plan, interval: change.interval, cancelAt: change.cancelAt })
    if (change.period) Object.assign(workspaceRow.current as object, { currentPeriodStart: change.period.start, validUntil: change.period.end })
  },
  recordSeatChange: async (_ws: unknown, change: { seats: number }) => {
    Object.assign(workspaceRow.current as object, { seats: change.seats })
  },
  upsertWorkspaceSubscription: async (_by: unknown, _tx: unknown, _wsId: string, values: WorkspaceSubscriptionFromStripe) => {
    Object.assign(workspaceRow.current as object, values)
  }
}))

vi.mock('../../../server/utils/billing/stripeClient', () => ({ useStripeClient: () => fakeStripe }))
vi.mock('../../../server/utils/billing/paidTerms', async orig => ({
  ...(await orig<typeof import('../../../server/utils/billing/paidTerms')>()),
  recordPaidTermsAcceptance: async () => {}
}))
vi.mock('../../../server/repos/audit', () => ({ appendAuditEvent: async () => {} }))
vi.mock('../../../server/utils/platform/clientIp', () => ({ getClientIp: () => null }))
vi.mock('../../../server/utils/litellm/workspaceTeams', () => ({
  readWorkspaceTeam: async () => null,
  ensureWorkspaceTeam: async () => 'team',
  syncAllMemberKeyLimits: async () => {}
}))

const { startProCheckout } = await import('../../../server/utils/billing/proCheckout')
const { startWorkspaceCheckout } = await import('../../../server/utils/billing/workspaceCheckout')
const { changeWorkspaceSeats, cancelWorkspaceSubscriptionAtPeriodEnd } = await import('../../../server/utils/billing/workspaceStripe')
const { handleSubscriptionUpdated } = await import('../../../server/utils/billing/stripeEvents/subscriptionEvents')
const { resetStripeCatalogueCache } = await import('../../../server/utils/billing/stripePrices')

function stateInUserRow(): State {
  return { plan: userRow.plan as Plan, interval: userRow.billingInterval as Interval, seats: 1, ending: userRow.planCancelAt !== null }
}

function stateInWorkspaceRow(): State {
  const row = workspaceRowNow()
  return { plan: row.plan, interval: row.interval, seats: row.seats, ending: row.cancelAt !== null }
}

/** The webhook Stripe sends for whatever the subscription is now. */
async function deliverSubscriptionUpdated(): Promise<void> {
  const event = partial<Stripe.CustomerSubscriptionUpdatedEvent>({
    id: 'evt_table',
    type: 'customer.subscription.updated',
    data: { object: stripeSubscription() }
  })
  const result = await handleSubscriptionUpdated(event, { stripe: fakeStripe })
  expect(result.matched).toBe(1)
}

const EVENT = partial<H3Event>({})
const TERMS = { acceptPaidTerms: true }

// ── The table ────────────────────────────────────────────────────────

type Request
  = | { name: 'plan', value: Plan }
    | { name: 'interval', value: Interval }
    | { name: 'seats', value: number }
    | { name: 'cancel' }
    | { name: 'resume' }

/** The state a request asks for: the current one with the named field set. */
function requested(state: State, request: Request): State {
  switch (request.name) {
    case 'plan': return { ...state, plan: request.value }
    case 'interval': return { ...state, interval: request.value }
    case 'seats': return { ...state, seats: request.value }
    case 'cancel': return { ...state, ending: true }
    case 'resume': return { ...state, ending: false }
  }
}

/**
 * THE RULE: only the named field changes. Its one deliberate exception:
 * choosing a plan or a billing period on a subscription that is ending is
 * a purchase, so the subscription runs on (`cancel_at_period_end: false`
 * in `changeSubscriptionPrice` and the workspace's `changePlanInPlace`).
 * A seat change is not a purchase of a plan and leaves an ending
 * subscription ending.
 */
function expectedAfter(state: State, request: Request): State {
  const next = requested(state, request)
  const buysAPrice = (request.name === 'plan' || request.name === 'interval') && (next.plan !== state.plan || next.interval !== state.interval)
  return buysAPrice ? { ...next, ending: false } : next
}

function describeState(state: State): string {
  return `${state.plan} ${state.interval}ly, ${state.seats} seat(s), ${state.ending ? 'ending' : 'renewing'}`
}

function describeRequest(request: Request): string {
  return 'value' in request ? `${request.name} = ${request.value}` : request.name
}

function seed(state: State, customer: string): void {
  Object.assign(stripeState, { customer, priceId: priceIdOf(state.plan, state.interval), quantity: state.seats, ending: state.ending, updates: 0 })
  const cancelAt = state.ending ? new Date(periodEnd(state.interval) * 1000) : null
  Object.assign(userRow, { plan: 'pro', billingInterval: state.interval, planCancelAt: cancelAt, planValidUntil: new Date(periodEnd(state.interval) * 1000) })
  workspaceRow.current = partial<WorkspaceSubscriptionRow>({
    workspaceId: WS_ID,
    plan: state.plan === 'pro' ? 'team' : state.plan,
    seats: state.seats,
    status: 'active',
    stripeCustomerId: WS_CUSTOMER,
    stripeSubscriptionId: SUB_ID,
    currency: 'eur',
    interval: state.interval,
    cancelAt,
    currentPeriodStart: new Date(NOW_S * 1000),
    validUntil: new Date(periodEnd(state.interval) * 1000),
    budgetSeatAdjust: 0,
    budgetSeatAdjustUntil: null,
    billingAdminId: USER_ID
  })
}

beforeEach(() => {
  vi.stubEnv('NUXT_STRIPE_PRICE_IDS', PRICE_IDS)
  resetStripeCatalogueCache()
})

describe('personal subscription (Pro): a request changes only what it names', () => {
  const states: State[] = (['month', 'year'] as const).flatMap(interval => [false, true].map(ending => ({ plan: 'pro' as const, interval, seats: 1, ending })))
  const requests: Request[] = [
    { name: 'plan', value: 'pro' },
    { name: 'interval', value: 'month' },
    { name: 'interval', value: 'year' },
    { name: 'cancel' },
    { name: 'resume' }
  ]

  /** How the request reaches Stripe. Returns false when the app refuses it (nothing may change). */
  async function send(request: Request): Promise<boolean> {
    if (request.name === 'cancel' || request.name === 'resume') {
      // The Stripe portal's "Cancel plan" / "Renew plan": no code of ours.
      await fakeStripe.subscriptions.update(SUB_ID, { cancel_at_period_end: request.name === 'cancel' })
      return true
    }
    try {
      // A plan request names no billing period; an interval request does.
      await startProCheckout(EVENT, { self: asUser(USER_ID), interval: request.name === 'interval' ? request.value : undefined, currency: undefined, terms: TERMS })
      return true
    } catch (e) {
      expect(e).toMatchObject({ statusCode: 409, data: { code: 'billing/already-on-plan' } })
      return false
    }
  }

  const cases = states.flatMap(state => requests.map(request => ({ state, request, title: `${describeState(state)}: ${describeRequest(request)}` })))

  it.each(cases)('$title', async ({ state, request }) => {
    seed(state, USER_CUSTOMER)
    const asked = requested(state, request)
    const sameAsNow = JSON.stringify(asked) === JSON.stringify(state)
    const viaPortal = request.name === 'cancel' || request.name === 'resume'
    const expected = expectedAfter(state, request)

    const accepted = await send(request)

    // Asking our endpoint for what the subscription already is buys
    // nothing: refused, and Stripe is not called.
    expect(accepted).toBe(viaPortal || !sameAsNow)
    expect(stripeState.updates > 0).toBe(accepted)
    expect(stateInStripe()).toEqual(expected)
    // The portal's changes reach the row with the webhook only.
    expect(stateInUserRow()).toEqual(viaPortal ? state : expected)

    await deliverSubscriptionUpdated()
    expect(stateInUserRow()).toEqual(expected)
    expect(stateInStripe()).toEqual(expected)
  })
})

describe('workspace subscription (Team / Business): a request changes only what it names', () => {
  const states: State[] = (['team', 'business'] as const).flatMap(plan => (['month', 'year'] as const).flatMap(interval => [3, 5].flatMap(seats => [false, true].map(ending => ({ plan, interval, seats, ending })))))
  const requests: Request[] = [
    { name: 'plan', value: 'team' },
    { name: 'plan', value: 'business' },
    { name: 'interval', value: 'month' },
    { name: 'interval', value: 'year' },
    { name: 'seats', value: 3 },
    { name: 'seats', value: 5 },
    { name: 'seats', value: 8 },
    { name: 'cancel' },
    { name: 'resume' }
  ]
  const ws = wsAs(WS_ID, USER_ID)

  async function send(request: Request): Promise<boolean> {
    switch (request.name) {
      case 'cancel':
        // The app's own cancellation (no billing admin left); the portal's does the same in Stripe.
        await cancelWorkspaceSubscriptionAtPeriodEnd(fakeStripe, workspaceRowNow())
        return true
      case 'resume':
        // The Stripe portal's "Renew plan".
        await fakeStripe.subscriptions.update(SUB_ID, { cancel_at_period_end: false })
        return true
      case 'seats':
        await changeWorkspaceSeats(fakeStripe, ws, workspaceRowNow(), request.value)
        return true
      default:
        try {
          // The request carries the one field its button changes.
          await startWorkspaceCheckout(EVENT, {
            ws,
            self: asUser(USER_ID),
            plan: request.name === 'plan' && request.value !== 'pro' ? request.value : undefined,
            interval: request.name === 'interval' ? request.value : undefined,
            currency: undefined,
            seats: undefined,
            terms: TERMS
          })
          return true
        } catch (e) {
          expect(e).toMatchObject({ statusCode: 409, data: { code: 'billing/already-on-plan' } })
          return false
        }
    }
  }

  const cases = states.flatMap(state => requests.map(request => ({ state, request, title: `${describeState(state)}: ${describeRequest(request)}` })))

  it.each(cases)('$title', async ({ state, request }) => {
    seed(state, WS_CUSTOMER)
    const asked = requested(state, request)
    const sameAsNow = JSON.stringify(asked) === JSON.stringify(state)
    const writtenByWebhookOnly = request.name === 'cancel' || request.name === 'resume'
    const expected = expectedAfter(state, request)

    const accepted = await send(request)

    // A plan or billing period the subscription already has is refused,
    // and Stripe is not called.
    const namesAPrice = request.name === 'plan' || request.name === 'interval'
    expect(accepted).toBe(!(namesAPrice && sameAsNow))
    expect(stripeState.updates > 0).toBe(accepted)
    expect(stateInStripe()).toEqual(expected)
    // A cancellation or a renewal reaches the row with the webhook only.
    expect(stateInWorkspaceRow()).toEqual(writtenByWebhookOnly ? state : expected)

    await deliverSubscriptionUpdated()
    expect(stateInWorkspaceRow()).toEqual(expected)
    expect(stateInStripe()).toEqual(expected)
  })
})
