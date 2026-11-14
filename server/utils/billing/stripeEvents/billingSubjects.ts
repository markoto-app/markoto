import type Stripe from 'stripe'
import * as Sentry from '@sentry/nuxt'
import type { WorkspacePlanName } from '~~/shared/config/tiers'
import type { PriceIdentity } from '~~/shared/config/pricing'
import { isKnownSubscriptionStatus, type StripeSubscriptionStatus } from '~~/shared/contracts/stripe'
import {
  findWorkspaceIdByStripeCustomer,
  getWorkspaceSubscriptionIn,
  getWorkspaceSubscriptionState,
  upsertWorkspaceSubscription,
  type WorkspaceSubscriptionRow
} from '../../../repos/workspaceSubscriptions'
import { findUserIdByStripeCustomer } from '../../../repos/userBilling'
import { getPooledWorkspace } from '../workspaceBilling'
import { ensureWorkspaceTeam, syncAllMemberKeyLimits } from '../../litellm/workspaceTeams'
import { subscriptionCancelAt, subscriptionPeriod } from './stripeObjects'
import type { TxHandle, DeferredAfterCommit } from './types'
import { useLogger } from '../../platform/logger'
import { system } from '../../../repos/proofs'

/** Stripe's webhook writes billing state for whichever customer the event names. */
const STRIPE = system('stripe-webhook')

// Who a Stripe customer is (a user or a workspace subscription) and the
// writes every handler makes on that subject.

const log = useLogger('stripe-webhook')

/**
 * Who a Stripe customer belongs to. Personal subscriptions use the user's
 * customer (`users.stripe_customer_id`); every Team / Business workspace
 * subscription has its OWN customer (`workspace_subscriptions
 * .stripe_customer_id`), so a customer id names exactly one subject.
 * `null` = not bound yet (the out-of-order stash case).
 */
export type CustomerSubject = { kind: 'user', userId: number } | { kind: 'workspace', workspaceId: string }

export async function subjectForCustomer(customerId: string, db: TxHandle | undefined): Promise<CustomerSubject | null> {
  const userId = await findUserIdByStripeCustomer(STRIPE, customerId, db)
  if (userId !== null) return { kind: 'user', userId }
  const workspaceId = await findWorkspaceIdByStripeCustomer(STRIPE, customerId, db)
  if (workspaceId !== null) return { kind: 'workspace', workspaceId }
  return null
}

/**
 * The status to store. A status the pinned API version doesn't know (a
 * newer one) is stored as `incomplete`: not entitled, like any unknown
 * status would be, and reported so the version bump gets done.
 */
function storedStatus(sub: Stripe.Subscription): StripeSubscriptionStatus {
  if (isKnownSubscriptionStatus(sub.status)) return sub.status
  log.warn('unknown subscription status stored as incomplete', { subscriptionId: sub.id, status: sub.status })
  Sentry.captureMessage('[stripe/webhook] unknown subscription status', { level: 'warning', tags: { component: 'stripeWebhook', event: 'unknown_subscription_status' } })
  return 'incomplete'
}

/**
 * Write a workspace's subscription state from a Stripe subscription
 * (insert on first sight, update after). Seats = the item quantity.
 */
export async function upsertWorkspaceSubscriptionFromStripe(
  db: TxHandle | undefined,
  args: {
    workspaceId: string
    sub: Stripe.Subscription
    identity: PriceIdentity & { plan: WorkspacePlanName }
    customerId: string
    billingAdminId?: number | null
  }
): Promise<void> {
  const item = args.sub.items.data[0]
  const period = subscriptionPeriod(args.sub)
  const values = {
    plan: args.identity.plan,
    seats: Math.max(1, item?.quantity ?? 1),
    status: storedStatus(args.sub),
    stripeCustomerId: args.customerId,
    stripeSubscriptionId: args.sub.id,
    currentPeriodStart: period.start,
    validUntil: period.end,
    cancelAt: subscriptionCancelAt(args.sub),
    currency: args.identity.currency,
    interval: args.identity.interval,
    updatedAt: new Date()
  }
  const billingAdmin = args.billingAdminId === undefined ? {} : { billingAdminId: args.billingAdminId }
  await upsertWorkspaceSubscription(STRIPE, db, args.workspaceId, values, billingAdmin)
}

/**
 * The workspace's subscription row when it holds a DIFFERENT subscription
 * than `subscriptionId`, else null. Only one subscription per workspace
 * is tracked; events of any other one must not overwrite it.
 */
export async function rowHoldingOtherSubscription(db: TxHandle | undefined, workspaceId: string, subscriptionId: string): Promise<WorkspaceSubscriptionRow | null> {
  const row = await getWorkspaceSubscriptionIn(STRIPE, db, workspaceId)
  return row?.stripeSubscriptionId && row.stripeSubscriptionId !== subscriptionId ? row : null
}

/** True when the workspace's row holds `subscriptionId` and it has ended (`canceled`). */
export async function isEndedSubscription(db: TxHandle | undefined, workspaceId: string, subscriptionId: string): Promise<boolean> {
  const row = await getWorkspaceSubscriptionState(STRIPE, db, workspaceId)
  return row?.id === subscriptionId && row.status === 'canceled'
}

/**
 * After commit: bring the workspace's LiteLLM team budget (seats ×
 * per-seat) and every member key's default limit in line with the
 * subscription the webhook just wrote. No-op unless entitled. Errors are
 * reported, never thrown: `litellm-key-reconcile` repairs drift.
 */
export function deferWorkspaceTeamSync(deferAfterCommit: DeferredAfterCommit | undefined, workspaceId: string): void {
  deferAfterCommit?.push(async () => {
    try {
      const pool = await getPooledWorkspace(workspaceId)
      if (!pool) return
      await ensureWorkspaceTeam(pool)
      await syncAllMemberKeyLimits(pool)
    } catch (e) {
      log.warn('workspace team sync failed', { workspaceId, err: e })
      Sentry.captureException(e, { tags: { component: 'stripeWebhook', event: 'workspace_team_sync_failed', workspaceId } })
    }
  })
}
