import { setTimeout as sleep } from 'node:timers/promises'
import Stripe from 'stripe'
import { nanoid } from 'nanoid'
import { STRIPE_API_VERSION } from '../../../shared/contracts/stripe'
import { HANDLED_STRIPE_EVENT_TYPES } from '../../../server/utils/billing/stripeEvents/eventHandlers'
import { computeStripeSig, TEST_WEBHOOK_SECRET } from '../../integration/setup/stripeHelpers'
import { CLOCK_NAME_PREFIX, RUN_TAG, SANDBOX_BASE_URL, STALE_RUN_SECONDS, WORKSPACE_ID_PREFIX, runId, sandboxKey } from './env'

// The suite's own Stripe access: creating the customers, cards,
// subscriptions and test clocks a browser would create through Checkout
// and the portal, reading the events Stripe produced for them, and
// delivering those to the local webhook endpoint.
//
// Every object carries the run tag (or, for test clocks, the name prefix)
// and nothing else is ever modified: the sandbox is shared with staging.

let client: Stripe | null = null

/** The suite's client, on the API version the app pins. */
export function sandboxStripe(): Stripe {
  if (client) return client
  const key = sandboxKey()
  if (!key) throw new Error('[billing-sandbox] no sandbox key')
  client = new Stripe(key, {
    apiVersion: STRIPE_API_VERSION as NonNullable<ConstructorParameters<typeof Stripe>[1]>['apiVersion'],
    // Parallel scenarios share the test-mode rate limit.
    maxNetworkRetries: 4
  })
  return client
}

/** The tag of this run, for `metadata`. */
export function runTag(): Record<string, string> {
  return { [RUN_TAG]: runId() }
}

/** Stripe's test payment methods the suite uses. */
export const CARD_OK = 'pm_card_visa'
/** Attaches fine, every charge is declined. */
export const CARD_DECLINES = 'pm_card_chargeCustomerFail'

const priceIds = new Map<string, string>()

/** A catalogue price by its lookup key (`markoto_pro_month_eur`, `markoto_topup_10_eur`, ...). */
export async function priceByLookupKey(stripe: Stripe, lookupKey: string): Promise<string> {
  const known = priceIds.get(lookupKey)
  if (known) return known
  const price = (await stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 })).data[0]
  if (!price) throw new Error(`[billing-sandbox] the sandbox has no active price with lookup key ${lookupKey}`)
  priceIds.set(lookupKey, price.id)
  return price.id
}

/** Unix seconds. */
function unix(date: Date = new Date()): number {
  return Math.floor(date.getTime() / 1000)
}

export const DAY_SECONDS = 24 * 3600

/** A test clock frozen at now. Deleting it deletes its customers and their subscriptions. */
export async function createClock(stripe: Stripe, label: string): Promise<Stripe.TestHelpers.TestClock> {
  return stripe.testHelpers.testClocks.create({ frozen_time: unix(), name: `${CLOCK_NAME_PREFIX} ${runId()} ${label}` })
}

/** How long a clock may take to reach its new time (each advance took 10 to 15 s when measured). */
const CLOCK_TIMEOUT_MS = 180_000

/** Move a clock forward and wait until Stripe has processed everything due by then. */
export async function advanceClock(stripe: Stripe, clockId: string, toUnix: number): Promise<void> {
  await stripe.testHelpers.testClocks.advance(clockId, { frozen_time: toUnix })
  const deadline = Date.now() + CLOCK_TIMEOUT_MS
  for (;;) {
    const clock = await stripe.testHelpers.testClocks.retrieve(clockId)
    if (clock.status === 'ready') return
    if (clock.status === 'internal_failure') throw new Error(`[billing-sandbox] test clock ${clockId} failed to advance`)
    if (Date.now() > deadline) throw new Error(`[billing-sandbox] test clock ${clockId} not ready after ${CLOCK_TIMEOUT_MS} ms`)
    await sleep(2000)
  }
}

/** A tagged customer with a default card, optionally on a test clock. */
export async function createCustomer(stripe: Stripe, args: { email: string, name?: string, clockId?: string, card?: string, metadata?: Record<string, string> }): Promise<Stripe.Customer> {
  const customer = await stripe.customers.create({
    email: args.email,
    ...(args.name ? { name: args.name } : {}),
    ...(args.clockId ? { test_clock: args.clockId } : {}),
    metadata: { ...runTag(), ...args.metadata }
  })
  await setDefaultCard(stripe, customer.id, args.card ?? CARD_OK)
  return customer
}

/** Attach a test payment method and make it the customer's default for invoices. */
export async function setDefaultCard(stripe: Stripe, customerId: string, card: string): Promise<string> {
  const pm = await stripe.paymentMethods.attach(card, { customer: customerId })
  await stripe.customers.update(customerId, { invoice_settings: { default_payment_method: pm.id } })
  return pm.id
}

/**
 * The subscription on the pinned API version: its billing period sits on
 * the subscription itself there (the SDK types describe a newer version).
 */
export type PinnedSubscription = Stripe.Subscription & { current_period_start: number, current_period_end: number }

/** A subscription the API answered in the pinned version, with its period typed. */
export function pinned(sub: Stripe.Subscription): PinnedSubscription {
  const start: unknown = Reflect.get(sub, 'current_period_start')
  const end: unknown = Reflect.get(sub, 'current_period_end')
  if (typeof start !== 'number' || typeof end !== 'number') {
    throw new Error(`[billing-sandbox] subscription ${sub.id} has no period on the subscription: the API did not answer in ${STRIPE_API_VERSION}`)
  }
  return Object.assign(sub, { current_period_start: start, current_period_end: end })
}

export async function retrieveSubscription(stripe: Stripe, id: string): Promise<PinnedSubscription> {
  return pinned(await stripe.subscriptions.retrieve(id))
}

// ── Events ───────────────────────────────────────────────────────────

type EventObjectRef = { id?: unknown, customer?: unknown }

function concernsCustomer(event: Stripe.Event, customerId: string): boolean {
  const object = event.data.object as EventObjectRef
  const customer = typeof object.customer === 'object' && object.customer !== null ? (object.customer as { id?: unknown }).id : object.customer
  return customer === customerId || object.id === customerId
}

const POLL_MS = 1500

/**
 * The events Stripe produced for one customer, read from the Events API
 * and handed out once each, in the order Stripe produced them.
 *
 * Only the types the app's webhook handles are read: those are the ones
 * the deployed endpoint is subscribed to.
 *
 * API version: the Events API renders `data.object` in the account's
 * default API version at the time of the event, whatever version the
 * request names (verified: `Stripe-Version` is ignored there). The
 * deployed endpoint is pinned to `STRIPE_API_VERSION` and gets that
 * rendering instead. So these payloads are real, but in the account's
 * version; the handlers read the version-dependent fields from both
 * places (`stripeEvents/stripeObjects.ts`), which is what this exercises.
 */
export class EventFeed {
  private readonly handedOut = new Set<string>()

  /** `sinceUnix`: Stripe's clock, e.g. the customer's `created`. */
  constructor(private readonly stripe: Stripe, private readonly customerId: string, private readonly sinceUnix: number) {}

  private async unseen(): Promise<Stripe.Event[]> {
    const found: Stripe.Event[] = []
    const listing = this.stripe.events.list({ created: { gte: this.sinceUnix - 5 }, types: [...HANDLED_STRIPE_EVENT_TYPES], limit: 100 })
    for await (const event of listing) {
      if (!this.handedOut.has(event.id) && concernsCustomer(event, this.customerId)) found.push(event)
    }
    // Listed newest first.
    return found.reverse()
  }

  /**
   * The customer's events not handed out yet. Waits until every type in
   * `expect` has shown up and nothing new arrived for `quietMs` (Stripe
   * writes events shortly after the API call that caused them returns).
   */
  async collect(expect: readonly Stripe.Event['type'][] = [], opts: { quietMs?: number, timeoutMs?: number } = {}): Promise<Stripe.Event[]> {
    const quietMs = opts.quietMs ?? 3000
    const deadline = Date.now() + (opts.timeoutMs ?? 90_000)
    let events: Stripe.Event[] = []
    let lastGrowth = Date.now()
    for (;;) {
      const now = await this.unseen()
      if (now.length !== events.length) lastGrowth = Date.now()
      events = now
      const missing = expect.filter(type => !events.some(e => e.type === type))
      if (missing.length === 0 && Date.now() - lastGrowth >= quietMs) break
      if (Date.now() > deadline) {
        throw new Error(`[billing-sandbox] events for ${this.customerId} did not settle: missing ${missing.join(', ') || 'none'}, have ${events.map(e => e.type).join(', ') || 'none'}`)
      }
      await sleep(POLL_MS)
    }
    for (const event of events) this.handedOut.add(event.id)
    return events
  }
}

export interface DeliveryResult {
  received: boolean
  handled: boolean
  replayed?: boolean
  stashed?: boolean
}

/**
 * POST one event to the app's webhook endpoint, signed with the test
 * server's webhook secret like Stripe signs a delivery. Anything but 200
 * fails the test: Stripe would retry it.
 */
export async function deliver(event: Stripe.Event | SubstituteEvent): Promise<DeliveryResult> {
  const payload = JSON.stringify(event)
  const res = await fetch(`${SANDBOX_BASE_URL}/api/webhooks/stripe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': computeStripeSig(payload, TEST_WEBHOOK_SECRET) },
    body: payload
  })
  if (res.status !== 200) {
    throw new Error(`[billing-sandbox] webhook answered ${res.status} for ${event.type} ${event.id}: ${(await res.text()).slice(0, 300)}`)
  }
  return await res.json() as DeliveryResult
}

/** Deliver events one after the other, in the given order. */
export async function deliverAll(events: ReadonlyArray<Stripe.Event | SubstituteEvent>): Promise<DeliveryResult[]> {
  const results: DeliveryResult[] = []
  for (const event of events) results.push(await deliver(event))
  return results
}

/** An event the suite had to build because Stripe offers no way to cause the real one by API. */
export interface SubstituteEvent {
  id: string
  object: 'event'
  api_version: string
  created: number
  livemode: false
  type: 'checkout.session.completed'
  data: { object: Stripe.Checkout.Session }
  pending_webhooks: number
  request: { id: null, idempotency_key: null }
}

/**
 * `checkout.session.completed` for a Checkout Session the app created.
 *
 * Stripe has no API to complete a Checkout Session: only its hosted page
 * can. The suite therefore does by API what the page would do (creates
 * the subscription or the payment for the same customer and price) and
 * builds this one event from the REAL session object the app created,
 * with the fields a completed session carries filled in. Every other
 * event the suite delivers is a real one from the Events API.
 */
export function completedCheckoutEvent(session: Stripe.Checkout.Session, completion: {
  customer: string
  subscription?: string
  paymentIntent?: string
  amountTotal?: number
}): SubstituteEvent {
  return {
    id: `evt_substitute_${nanoid(16)}`,
    object: 'event',
    api_version: STRIPE_API_VERSION,
    created: unix(),
    livemode: false,
    type: 'checkout.session.completed',
    data: {
      object: {
        ...session,
        status: 'complete',
        payment_status: 'paid',
        customer: completion.customer,
        subscription: completion.subscription ?? null,
        payment_intent: completion.paymentIntent ?? null,
        amount_total: completion.amountTotal ?? session.amount_total
      }
    },
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null }
  }
}

/** A deterministic shuffle (mulberry32), so a failing order can be reproduced from its seed. */
export function shuffled<T>(items: readonly T[], seed: number): T[] {
  let state = seed >>> 0
  const random = () => {
    state = (state + 0x6D2B79F5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    const a = out[i] as T
    out[i] = out[j] as T
    out[j] = a
  }
  return out
}

// ── Clean-up ─────────────────────────────────────────────────────────

/** Expire a Checkout Session the app opened (it would stay payable for a day). */
export async function expireCheckout(stripe: Stripe, sessionId: string): Promise<void> {
  try {
    await stripe.checkout.sessions.expire(sessionId)
  } catch (e) {
    // Already expired or completed.
    if ((e as { type?: string })?.type !== 'StripeInvalidRequestError') throw e
  }
}

async function deleteQuietly(remove: () => Promise<unknown>): Promise<boolean> {
  try {
    await remove()
    return true
  } catch (e) {
    if ((e as { code?: string })?.code === 'resource_missing') return false
    throw e
  }
}

/** Delete a test clock and, with it, its customers and their subscriptions. */
export async function deleteClock(stripe: Stripe, clockId: string): Promise<void> {
  await deleteQuietly(() => stripe.testHelpers.testClocks.del(clockId))
}

/** Delete a customer the suite created (tagged) or caused (the app's customer of a suite workspace). */
export async function deleteCustomer(stripe: Stripe, customerId: string): Promise<void> {
  await deleteQuietly(() => stripe.customers.del(customerId))
}

function isSuiteClock(clock: Stripe.TestHelpers.TestClock, run: string | null): boolean {
  return (clock.name ?? '').startsWith(run ? `${CLOCK_NAME_PREFIX} ${run} ` : `${CLOCK_NAME_PREFIX} `)
}

function isSuiteCustomer(customer: Stripe.Customer, run: string | null): boolean {
  const tag = customer.metadata?.[RUN_TAG]
  if (tag) return run === null || tag === run
  // The customer the app itself creates for a workspace of the suite.
  const workspaceId = customer.metadata?.workspace_id ?? ''
  return workspaceId.startsWith(run ? `${WORKSPACE_ID_PREFIX}-${run}-` : `${WORKSPACE_ID_PREFIX}-`)
}

/**
 * Everything one run left in the sandbox: its test clocks (with their
 * customers) and its customers outside a clock. The last line of defence
 * behind each suite's own clean-up.
 */
export async function removeRunObjects(stripe: Stripe, run: string): Promise<{ clocks: number, customers: number }> {
  const removed = { clocks: 0, customers: 0 }
  for await (const clock of stripe.testHelpers.testClocks.list({ limit: 100 })) {
    if (isSuiteClock(clock, run) && await deleteQuietly(() => stripe.testHelpers.testClocks.del(clock.id))) removed.clocks++
  }
  // Customers on a test clock are not listed here; they went with it.
  for await (const customer of stripe.customers.list({ created: { gte: unix() - 6 * 3600 }, limit: 100 })) {
    if (isSuiteCustomer(customer, run) && await deleteQuietly(() => stripe.customers.del(customer.id))) removed.customers++
  }
  return removed
}

/** What a run that died (a killed CI job) left behind, once it is old enough not to be a run in progress. */
export async function removeStaleRunObjects(stripe: Stripe): Promise<void> {
  const cutoff = unix() - STALE_RUN_SECONDS
  let removed = 0
  for await (const clock of stripe.testHelpers.testClocks.list({ limit: 100 })) {
    if (isSuiteClock(clock, null) && clock.created < cutoff && await deleteQuietly(() => stripe.testHelpers.testClocks.del(clock.id))) removed++
  }
  for await (const customer of stripe.customers.list({ created: { gte: cutoff - 7 * DAY_SECONDS, lt: cutoff }, limit: 100 })) {
    if (isSuiteCustomer(customer, null) && await deleteQuietly(() => stripe.customers.del(customer.id))) removed++
  }
  if (removed > 0) console.log(`[billing-sandbox] removed ${removed} object(s) of earlier runs that did not clean up`)
}

/** A run's objects still in the sandbox: empty after `removeRunObjects`, or the run did not leave it clean. */
export async function listRunObjects(stripe: Stripe, run: string): Promise<string[]> {
  const left: string[] = []
  for await (const clock of stripe.testHelpers.testClocks.list({ limit: 100 })) {
    if (isSuiteClock(clock, run)) left.push(clock.id)
  }
  for await (const customer of stripe.customers.list({ created: { gte: unix() - 6 * 3600 }, limit: 100 })) {
    if (isSuiteCustomer(customer, run)) left.push(customer.id)
  }
  return left
}
