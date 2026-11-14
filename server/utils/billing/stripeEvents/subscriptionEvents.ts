import type Stripe from 'stripe'
import * as Sentry from '@sentry/nuxt'
import type { PersonalPlanName, PlanName, WorkspacePlanName } from '~~/shared/config/tiers'
import type { PriceIdentity } from '~~/shared/config/pricing'
import { markWorkspaceSubscriptionCanceled, subscriptionGrantsPlan } from '../../../repos/workspaceSubscriptions'
import { notifyWorkspaceAdmins } from '../../email/workspaceBillingEmails'
import { updateUserKeyBudget, resetUserKeySpend } from '../../litellm/userKeys'
import { identifyItem, isWorkspaceIdentity, subscriptionCancelAt, subscriptionPeriod, warnUnknownPrice } from './stripeObjects'
import {
  deferWorkspaceTeamSync,
  isEndedSubscription,
  rowHoldingOtherSubscription,
  subjectForCustomer,
  upsertWorkspaceSubscriptionFromStripe
} from './billingSubjects'
import { applyUserSubscriptionState, findUserIdByStripeCustomer, updateUserBilling, type UserBillingUpdate } from '../../../repos/userBilling'
import type { TxHandle, DeferredAfterCommit } from './types'
import { useLogger } from '../../platform/logger'
import { system } from '../../../repos/proofs'

/** Stripe's webhook writes billing state for whichever customer the event names. */
const STRIPE = system('stripe-webhook')

// Subscription lifecycle: created / updated (plan, seats, interval,
// cancel-at-period-end, dunning status) and deleted. Routed by the
// customer's subject: a user (Pro) or a workspace (Team / Business).

const log = useLogger('stripe-webhook')

type SubscriptionResult = { matched: number, plan: PlanName | null }

type SubscriptionChangeEvent = Stripe.CustomerSubscriptionUpdatedEvent | Stripe.CustomerSubscriptionCreatedEvent

/**
 * `customer.subscription.created|updated` handler. Plan changes, seat
 * changes, monthly ↔ annual swaps, `cancel_at_period_end` toggles,
 * period rollover, dunning status. Routed by the customer's subject.
 *
 * Scheduled downgrades (`cancel_at_period_end=true`): the plan stays
 * until `customer.subscription.deleted` fires at period end.
 */
export async function handleSubscriptionUpdated(
  event: SubscriptionChangeEvent,
  opts: { stripe?: Stripe | null, db?: TxHandle, deferAfterCommit?: DeferredAfterCommit } = {}
): Promise<SubscriptionResult> {
  const db = opts.db
  const sub = event.data.object
  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id
  const item = sub.items.data[0]
  const identity = await identifyItem(opts.stripe ?? null, item)
  const subject = await subjectForCustomer(customerId, db)

  if (subject?.kind === 'workspace') {
    if (!isWorkspaceIdentity(identity)) {
      warnUnknownPrice(`subscription.${event.type.split('.').pop()} (workspace)`, item?.price?.id, `sub=${sub.id}`)
      return { matched: 0, plan: null }
    }
    return applyWorkspaceSubscription(event, { db, workspaceId: subject.workspaceId, identity, customerId, deferAfterCommit: opts.deferAfterCommit })
  }

  if (identity?.plan !== 'pro') {
    warnUnknownPrice(`subscription.${event.type.split('.').pop()}`, item?.price?.id, `sub=${sub.id}`)
    return { matched: 0, plan: null }
  }
  return applyPersonalSubscription(event, { db, plan: identity.plan, identity, customerId, deferAfterCommit: opts.deferAfterCommit })
}

async function applyWorkspaceSubscription(
  event: SubscriptionChangeEvent,
  args: { db: TxHandle | undefined, workspaceId: string, identity: PriceIdentity & { plan: WorkspacePlanName }, customerId: string, deferAfterCommit?: DeferredAfterCommit }
): Promise<SubscriptionResult> {
  const { db, workspaceId, identity, customerId } = args
  const sub = event.data.object
  // Another subscription is the workspace's live one (this is a
  // duplicate being cancelled, or a late event of an old one).
  const holder = await rowHoldingOtherSubscription(db, workspaceId, sub.id)
  if (holder && subscriptionGrantsPlan(holder)) {
    log.warn('ignoring event: the workspace is on another subscription', { eventType: event.type, subscriptionId: sub.id, workspaceId, holderSubscriptionId: holder.stripeSubscriptionId })
    return { matched: 0, plan: null }
  }
  // A cancelled subscription never comes back in Stripe, so an event
  // that says otherwise is an older one delivered late (a retry after
  // `customer.subscription.deleted`) and must not re-entitle the workspace.
  if (await isEndedSubscription(db, workspaceId, sub.id)) {
    log.warn('ignoring late event of an ended subscription', { eventType: event.type, subscriptionId: sub.id, workspaceId })
    return { matched: 0, plan: null }
  }
  await upsertWorkspaceSubscriptionFromStripe(db, { workspaceId, sub, identity, customerId })
  deferWorkspaceTeamSync(args.deferAfterCommit, workspaceId)
  // Cancelled to the period end (portal, or no billing admin left):
  // tell the admins once per subscription + period.
  if (sub.cancel_at_period_end) {
    const end = subscriptionPeriod(sub).end
    args.deferAfterCommit?.push(async () => {
      await notifyWorkspaceAdmins({ workspaceId, kind: 'ending', date: end, onceKey: `ending:${sub.id}:${end?.getTime() ?? 0}` })
    })
  }
  return { matched: 1, plan: identity.plan }
}

async function applyPersonalSubscription(
  event: SubscriptionChangeEvent,
  args: { db: TxHandle | undefined, plan: PersonalPlanName, identity: PriceIdentity, customerId: string, deferAfterCommit?: DeferredAfterCommit }
): Promise<SubscriptionResult> {
  const { db, plan, identity, customerId } = args
  const sub = event.data.object
  const period = subscriptionPeriod(sub)
  const setFields: UserBillingUpdate['set'] = {
    plan,
    billingCurrency: identity.currency,
    billingInterval: identity.interval,
    planCancelAt: subscriptionCancelAt(sub)
  }
  if (period.start) setFields.stripeCurrentPeriodStart = period.start
  if (period.end) setFields.planValidUntil = period.end
  // Only the user's current subscription (stamped by the checkout) is
  // applied. `customer.subscription.deleted` clears it, so a late event
  // of an ended subscription can't bring Pro back; a new subscription's
  // events that beat its checkout are covered by the checkout, which
  // reads the live subscription.
  const matched = await applyUserSubscriptionState(STRIPE, db, customerId, sub.id, setFields)
  if (matched === 0) {
    log.warn('ignoring event: not the customer\'s current subscription', { eventType: event.type, subscriptionId: sub.id })
    return { matched: 0, plan: null }
  }

  // Deferred LiteLLM key budget sync (see handleCheckoutSessionCompleted).
  if (args.deferAfterCommit) {
    args.deferAfterCommit.push(async () => {
      try {
        const userId = await findUserIdByStripeCustomer(STRIPE, customerId)
        if (userId !== null) {
          await updateUserKeyBudget(userId, plan)
        }
      } catch (e) {
        log.warn('LiteLLM key budget sync failed', { customerId, plan, err: e })
        Sentry.captureException(e, {
          tags: { component: 'stripeWebhook', event: 'litellm_key_sync_failed', customerId }
        })
      }
    })
  }

  return { matched, plan }
}

/**
 * `customer.subscription.deleted` handler.
 *   - Personal: revert to Free and null the Stripe anchor (the resolver
 *     falls back to the calendar month). `stripeCustomerId` and
 *     `billingCurrency` stay: a resubscription reuses the customer.
 *   - Workspace: mark the subscription `canceled` (the row stays as the
 *     record; `resolveWorkspacePlan` stops granting the plan).
 */
export async function handleSubscriptionDeleted(
  event: Stripe.CustomerSubscriptionDeletedEvent,
  db?: TxHandle,
  deferAfterCommit?: DeferredAfterCommit
): Promise<{ matched: number }> {
  const handle = db
  const sub = event.data.object
  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id
  const subject = await subjectForCustomer(customerId, handle)

  if (subject?.kind === 'workspace') {
    // Only the tracked subscription ends the workspace's plan (not a
    // cancelled duplicate, not an old subscription's late event).
    if (await rowHoldingOtherSubscription(handle, subject.workspaceId, sub.id)) return { matched: 0 }
    const matched = await markWorkspaceSubscriptionCanceled(STRIPE, handle, subject.workspaceId)
    // The team + member keys stay (unused while not entitled: members
    // fall back to their personal keys); a resubscription reuses them and
    // workspace deletion removes them (`endWorkspaceBilling`).
    const workspaceId = subject.workspaceId
    deferAfterCommit?.push(async () => {
      await notifyWorkspaceAdmins({ workspaceId, kind: 'ended', onceKey: `ended:${sub.id}` })
    })
    return { matched }
  }

  const matched = await updateUserBilling(STRIPE, {
    where: { stripeCustomerId: customerId },
    set: {
      plan: 'free',
      stripeSubscriptionId: null,
      stripeCurrentPeriodStart: null,
      planValidUntil: null,
      billingInterval: null,
      planCancelAt: null
    }
  }, handle)

  // Drop the LiteLLM key budget to the free-tier value, deferred to
  // post-commit (see handleCheckoutSessionCompleted).
  if (deferAfterCommit) {
    deferAfterCommit.push(async () => {
      try {
        const userId = await findUserIdByStripeCustomer(STRIPE, customerId)
        if (userId !== null) {
          await updateUserKeyBudget(userId, 'free')
          // Un-brick: a user who spent more than the free cap while on a
          // paid plan would otherwise sit over-budget until the monthly
          // budget_duration reset. Reset spend now.
          await resetUserKeySpend(userId)
        }
      } catch (e) {
        log.warn('LiteLLM key drop-to-free failed', { customerId, err: e })
        Sentry.captureException(e, {
          tags: { component: 'stripeWebhook', event: 'litellm_key_sync_failed', customerId }
        })
      }
    })
  }

  return { matched }
}
