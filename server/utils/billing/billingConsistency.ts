import type Stripe from 'stripe'
import { listTrackedUserSubscriptions, type TrackedUserSubscription } from '../../repos/userBilling'
import { listAllWorkspaceSubscriptions, type WorkspaceSubscriptionRow } from '../../repos/workspaceSubscriptions'
import { system } from '../../repos/proofs'
import { identifyItem, stripeId } from './stripeEvents/stripeObjects'
import { BILLING_SUBSCRIPTION_STATUSES, TEST_RUN_METADATA_KEY } from './sandboxSubscriptions'

// Billing consistency: does Stripe bill exactly the subscriptions markoto
// tracks, with the plan, billing period and seats markoto thinks? Drift
// comes from webhooks that never arrived, a subscription changed by hand
// in the Stripe dashboard, a database restored from a backup, or a bug.
// Read-only: it reports, an operator decides. Used by the admin page
// (`/api/admin/billing-consistency`) and the daily
// `billing-consistency-check` sweeper.

const CHECK = system('billing-consistency')

/**
 * - `untracked`: Stripe bills a subscription no user or workspace row tracks.
 * - `not-live-in-stripe`: a row tracks a live subscription Stripe no longer bills (or does not know).
 * - `unknown-price`: the subscription's price is not one of ours (no plan can be read from it).
 * - `customer`: the row's Stripe customer is not the subscription's.
 * - `status`, `plan`, `interval`, `seats`: the two sides disagree on that value.
 */
export type BillingMismatchKind
  = | 'untracked'
    | 'not-live-in-stripe'
    | 'status'
    | 'plan'
    | 'interval'
    | 'seats'
    | 'unknown-price'
    | 'customer'

export interface BillingMismatch {
  kind: BillingMismatchKind
  subscriptionId: string
  /** Who markoto (or, for `untracked`, the subscription's metadata) says it belongs to. */
  subject: { type: 'user' | 'workspace', id: string } | null
  stripe: string | number | null
  markoto: string | number | null
}

export interface BillingConsistencyReport {
  checkedAt: string
  /** Active, trialing and past-due subscriptions in Stripe (the test suite's own excluded). */
  stripeLive: number
  trackedLive: { users: number, workspaces: number }
  mismatches: BillingMismatch[]
}

const LIVE: readonly string[] = BILLING_SUBSCRIPTION_STATUSES

type Tracked
  = | { type: 'user', row: TrackedUserSubscription }
    | { type: 'workspace', row: WorkspaceSubscriptionRow }

function subjectOf(t: Tracked): BillingMismatch['subject'] {
  return t.type === 'user' ? { type: 'user', id: String(t.row.userId) } : { type: 'workspace', id: t.row.workspaceId }
}

function isTrackedLive(t: Tracked): boolean {
  // A user row written before the status column existed has none: it
  // tracks the subscription, so it counts as live.
  return t.row.status === null || LIVE.includes(t.row.status)
}

function metadataSubject(sub: Stripe.Subscription): BillingMismatch['subject'] {
  const type = sub.metadata?.subject_type
  const id = sub.metadata?.subject_id
  return (type === 'user' || type === 'workspace') && id ? { type, id } : null
}

async function listStripeLive(stripe: Stripe): Promise<Stripe.Subscription[]> {
  const out: Stripe.Subscription[] = []
  for (const status of BILLING_SUBSCRIPTION_STATUSES) {
    for await (const sub of stripe.subscriptions.list({ status, limit: 100 })) {
      if (sub.metadata?.[TEST_RUN_METADATA_KEY]) continue
      out.push(sub)
    }
  }
  return out
}

/** Stripe's status of a subscription no live listing returned: `missing` when Stripe does not know it. */
async function stripeStatusOf(stripe: Stripe, subscriptionId: string): Promise<string> {
  try {
    return (await stripe.subscriptions.retrieve(subscriptionId)).status
  } catch (e) {
    if ((e as { code?: string })?.code === 'resource_missing' || (e as { statusCode?: number })?.statusCode === 404) return 'missing'
    throw e
  }
}

async function compare(stripe: Stripe, sub: Stripe.Subscription, t: Tracked): Promise<BillingMismatch[]> {
  const out: BillingMismatch[] = []
  const base = { subscriptionId: sub.id, subject: subjectOf(t) }
  const push = (kind: BillingMismatchKind, stripeValue: string | number | null, markotoValue: string | number | null) => {
    if (stripeValue !== markotoValue) out.push({ kind, ...base, stripe: stripeValue, markoto: markotoValue })
  }
  if (t.row.status !== null) push('status', sub.status, t.row.status)
  const rowCustomer = t.type === 'user' ? t.row.customerId : t.row.stripeCustomerId
  const customer = stripeId(sub.customer)
  if (rowCustomer && customer) push('customer', customer, rowCustomer)

  const item = sub.items.data[0]
  const identity = await identifyItem(stripe, item)
  if (!identity) {
    out.push({ kind: 'unknown-price', ...base, stripe: item?.price?.id ?? null, markoto: t.row.plan })
    return out
  }
  push('plan', identity.plan, t.row.plan)
  if (t.row.interval !== null) push('interval', identity.interval, t.row.interval)
  if (t.type === 'workspace') push('seats', item?.quantity ?? null, t.row.seats)
  return out
}

/**
 * Compare Stripe's live subscriptions with markoto's rows, both ways:
 * every live Stripe subscription must be tracked by a user
 * (`users.stripe_subscription_id`) or a workspace
 * (`workspace_subscriptions.stripe_subscription_id`) with matching
 * status, plan, billing period and seats; every subscription a row tracks
 * as live must be live in Stripe. Stripe is read in pages of 100.
 */
export async function checkBillingConsistency(stripe: Stripe, now: Date = new Date()): Promise<BillingConsistencyReport> {
  const [stripeLive, users, workspaces] = await Promise.all([
    listStripeLive(stripe),
    listTrackedUserSubscriptions(CHECK),
    listAllWorkspaceSubscriptions(CHECK)
  ])
  const tracked = new Map<string, Tracked>()
  for (const row of workspaces) if (row.stripeSubscriptionId) tracked.set(row.stripeSubscriptionId, { type: 'workspace', row })
  for (const row of users) tracked.set(row.subscriptionId, { type: 'user', row })

  const mismatches: BillingMismatch[] = []
  const seen = new Set<string>()
  for (const sub of stripeLive) {
    seen.add(sub.id)
    const t = tracked.get(sub.id)
    if (!t) {
      mismatches.push({ kind: 'untracked', subscriptionId: sub.id, subject: metadataSubject(sub), stripe: sub.status, markoto: null })
      continue
    }
    mismatches.push(...await compare(stripe, sub, t))
  }

  let liveUsers = 0
  let liveWorkspaces = 0
  for (const [subscriptionId, t] of tracked) {
    if (!isTrackedLive(t)) continue
    if (t.type === 'user') liveUsers++
    else liveWorkspaces++
    if (seen.has(subscriptionId)) continue
    const status = await stripeStatusOf(stripe, subscriptionId)
    mismatches.push({ kind: 'not-live-in-stripe', subscriptionId, subject: subjectOf(t), stripe: status, markoto: t.row.status ?? 'tracked' })
  }

  return {
    checkedAt: now.toISOString(),
    stripeLive: stripeLive.length,
    trackedLive: { users: liveUsers, workspaces: liveWorkspaces },
    mismatches
  }
}
