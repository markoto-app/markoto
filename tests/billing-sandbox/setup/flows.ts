import type Stripe from 'stripe'
import { expect } from 'vitest'
import {
  CARD_OK,
  EventFeed,
  completedCheckoutEvent,
  createClock,
  createCustomer,
  deleteCustomer,
  deliverAll,
  expireCheckout,
  priceByLookupKey,
  retrieveSubscription,
  runTag,
  type PinnedSubscription,
  type SubstituteEvent
} from './stripe'
import { createSuiteWorkspace, post, setWorkspaceCustomer, signedInUser, workspaceCustomerId, type AppUser } from './app'

// The purchases every scenario starts from, done the way the app's own
// flow does them as far as Stripe's API allows:
//
//   1. the app's checkout endpoint opens the Checkout Session (asserted);
//   2. the suite does by API what Stripe's hosted page would do: a
//      customer with a test card, and the subscription (or payment) for
//      the session's price;
//   3. the real events Stripe produced are delivered to the webhook,
//      together with ONE built event, `checkout.session.completed`
//      (`completedCheckoutEvent` says why).

type AnyEvent = Stripe.Event | SubstituteEvent

/** The Checkout Session the app opened, with its line items. */
async function openedSession(stripe: Stripe, sessionId: string): Promise<Stripe.Checkout.Session> {
  return stripe.checkout.sessions.retrieve(sessionId, { expand: ['line_items'] })
}

function onlyLineItem(session: Stripe.Checkout.Session): Stripe.LineItem {
  const items = session.line_items?.data ?? []
  expect(items).toHaveLength(1)
  return items[0] as Stripe.LineItem
}

export interface ProPurchase {
  app: AppUser
  customer: Stripe.Customer
  /** The clock the customer lives on, when the scenario moves time. */
  clockId: string | null
  subscription: PinnedSubscription
  feed: EventFeed
  session: Stripe.Checkout.Session
  /** The purchase's events in the order Stripe produced them, the built checkout event last. */
  purchaseEvents: AnyEvent[]
}

/**
 * Free to Pro: the app's checkout for a new subscriber, completed by API.
 * Nothing is delivered to the webhook yet: `deliverPurchase` does that,
 * or the scenario delivers `purchaseEvents` in an order of its own.
 */
export async function buyPro(stripe: Stripe, label: string, opts: { interval?: 'month' | 'year', clock?: boolean } = {}): Promise<ProPurchase> {
  const interval = opts.interval ?? 'month'
  const app = await signedInUser(label)

  const checkout = await post<{ url?: string, sessionId?: string }>(app.client, '/api/billing/checkout', { plan: 'pro', interval, currency: 'eur', acceptPaidTerms: true })
  expect(checkout.status).toBe(200)
  expect(checkout.body.url).toMatch(/^https:\/\/checkout\.stripe\.com\//)
  const session = await openedSession(stripe, checkout.body.sessionId as string)
  const priceId = await priceByLookupKey(stripe, `markoto_pro_${interval}_eur`)
  expect(session).toMatchObject({
    mode: 'subscription',
    status: 'open',
    client_reference_id: String(app.user.id),
    customer: null,
    customer_email: app.user.email,
    metadata: { subject_type: 'user', subject_id: String(app.user.id) }
  })
  expect(onlyLineItem(session)).toMatchObject({ quantity: 1, price: { id: priceId, lookup_key: `markoto_pro_${interval}_eur` } })

  // What the hosted page does on payment: the customer (Checkout creates
  // it from `customer_email`), the card, the subscription.
  const clock = opts.clock ? await createClock(stripe, label) : null
  const customer = await createCustomer(stripe, { email: app.user.email, name: app.user.name, clockId: clock?.id, card: CARD_OK })
  const created = await stripe.subscriptions.create({
    customer: customer.id,
    items: [{ price: priceId, quantity: 1 }],
    metadata: { subject_type: 'user', subject_id: String(app.user.id), ...runTag() }
  })
  expect(created.status).toBe('active')
  await expireCheckout(stripe, session.id)

  const feed = new EventFeed(stripe, customer.id, customer.created)
  const real = await feed.collect(['customer.subscription.created', 'invoice.paid'])
  return {
    app,
    customer,
    clockId: clock?.id ?? null,
    subscription: await retrieveSubscription(stripe, created.id),
    feed,
    session,
    purchaseEvents: [...real, completedCheckoutEvent(session, { customer: customer.id, subscription: created.id })]
  }
}

/** Deliver the purchase as Stripe would: every event once, in order. */
export async function deliverPurchase(purchase: { purchaseEvents: AnyEvent[] }): Promise<void> {
  const results = await deliverAll(purchase.purchaseEvents)
  // The subscription's own events arrive before the checkout binds the
  // customer: they are stashed, and the checkout applies them.
  expect(results.every(r => r.received)).toBe(true)
}

/** A Pro subscriber the app knows about: bought and delivered. */
export async function proSubscriber(stripe: Stripe, label: string, opts: { interval?: 'month' | 'year', clock?: boolean } = {}): Promise<ProPurchase> {
  const purchase = await buyPro(stripe, label, opts)
  await deliverPurchase(purchase)
  return purchase
}

export interface WorkspacePurchase {
  app: AppUser
  workspaceId: string
  customer: Stripe.Customer
  clockId: string
  subscription: PinnedSubscription
  feed: EventFeed
  session: Stripe.Checkout.Session
  purchaseEvents: AnyEvent[]
}

/**
 * A workspace buys Team / Business: the app's checkout (which creates the
 * workspace's own Stripe customer), completed by API on a test clock.
 *
 * A customer can only join a test clock when it is created, so the
 * customer the app made is asserted and then replaced by one the suite
 * creates on the clock, with the same metadata.
 */
export async function buyWorkspacePlan(stripe: Stripe, label: string, opts: { plan: 'team' | 'business', interval?: 'month' | 'year', seats: number }): Promise<WorkspacePurchase> {
  const interval = opts.interval ?? 'month'
  const app = await signedInUser(label)
  const workspaceId = await createSuiteWorkspace(app.user, label)

  const path = `/api/workspaces/${workspaceId}/billing/checkout`
  const checkout = await post<{ url?: string, sessionId?: string }>(app.client, path, { plan: opts.plan, interval, currency: 'eur', seats: opts.seats, acceptPaidTerms: true })
  expect(checkout.status).toBe(200)
  const session = await openedSession(stripe, checkout.body.sessionId as string)
  const priceId = await priceByLookupKey(stripe, `markoto_${opts.plan}_${interval}_eur`)
  const appCustomerId = await workspaceCustomerId(workspaceId)
  expect(appCustomerId).toMatch(/^cus_/)
  expect(session).toMatchObject({
    mode: 'subscription',
    status: 'open',
    client_reference_id: `workspace:${workspaceId}`,
    customer: appCustomerId,
    metadata: { subject_type: 'workspace', subject_id: workspaceId, billing_admin_id: String(app.user.id) }
  })
  expect(onlyLineItem(session)).toMatchObject({ quantity: opts.seats, price: { id: priceId } })
  const appCustomer = await stripe.customers.retrieve(appCustomerId as string)
  expect(appCustomer).toMatchObject({ email: app.user.email, metadata: { workspace_id: workspaceId, subject_type: 'workspace' } })

  await expireCheckout(stripe, session.id)
  await deleteCustomer(stripe, appCustomerId as string)
  const clock = await createClock(stripe, label)
  const customer = await createCustomer(stripe, {
    email: app.user.email,
    name: `Sandbox ${label}`,
    clockId: clock.id,
    metadata: { workspace_id: workspaceId, subject_type: 'workspace' }
  })
  await setWorkspaceCustomer(workspaceId, customer.id)

  const created = await stripe.subscriptions.create({
    customer: customer.id,
    items: [{ price: priceId, quantity: opts.seats }],
    metadata: { ...session.metadata, ...runTag() }
  })
  expect(created.status).toBe('active')

  const feed = new EventFeed(stripe, customer.id, customer.created)
  const real = await feed.collect(['customer.subscription.created', 'invoice.paid'])
  return {
    app,
    workspaceId,
    customer,
    clockId: clock.id,
    subscription: await retrieveSubscription(stripe, created.id),
    feed,
    session,
    purchaseEvents: [...real, completedCheckoutEvent(session, { customer: customer.id, subscription: created.id })]
  }
}

/**
 * A credit pack for a Pro subscriber: the app's top-up checkout, paid by
 * API with the customer's default card. Returns the built
 * `checkout.session.completed` (not delivered) and the payment.
 */
export async function buyCreditPack(stripe: Stripe, buyer: { app: AppUser, customer: Stripe.Customer }, pack: '10' | '25' | '50'): Promise<{ session: Stripe.Checkout.Session, paymentIntentId: string, completed: SubstituteEvent }> {
  const checkout = await post<{ url?: string, sessionId?: string }>(buyer.app.client, '/api/billing/topup', { pack, acceptPaidTerms: true })
  expect(checkout.status).toBe(200)
  const session = await openedSession(stripe, checkout.body.sessionId as string)
  const priceId = await priceByLookupKey(stripe, `markoto_topup_${pack}_eur`)
  const subject = { kind: 'topup', pack, subject_type: 'user', subject_id: String(buyer.app.user.id) }
  expect(session).toMatchObject({
    mode: 'payment',
    status: 'open',
    client_reference_id: String(buyer.app.user.id),
    customer: buyer.customer.id,
    currency: 'eur',
    metadata: subject
  })
  const item = onlyLineItem(session)
  expect(item).toMatchObject({ quantity: 1, price: { id: priceId } })

  // What the hosted page does: one card payment of the pack's price.
  const customer = await stripe.customers.retrieve(buyer.customer.id) as Stripe.Customer
  const card = customer.invoice_settings.default_payment_method
  const paid = await stripe.paymentIntents.create({
    amount: item.amount_total,
    currency: 'eur',
    customer: buyer.customer.id,
    payment_method: typeof card === 'string' ? card : card?.id,
    // A card only: no redirect-based method, so no return URL is needed.
    automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
    confirm: true,
    off_session: true,
    metadata: { ...subject, ...runTag() }
  })
  expect(paid.status).toBe('succeeded')
  await expireCheckout(stripe, session.id)
  return {
    session,
    paymentIntentId: paid.id,
    completed: completedCheckoutEvent(session, { customer: buyer.customer.id, paymentIntent: paid.id, amountTotal: item.amount_total })
  }
}
