import type Stripe from 'stripe'
import * as Sentry from '@sentry/nuxt'
import type { PersonalPlanName, PlanName } from '~~/shared/config/tiers'
import { cancelDuplicateWorkspaceSubscription } from '../workspaceStripe'
import { findLiveSubscription } from '../stripePlanChange'
import { updateUserKeyBudget } from '../../litellm/userKeys'
import { identifyItem, isWorkspaceIdentity, stripeId, subscriptionPeriod, warnUnknownPrice } from './stripeObjects'
import { deferWorkspaceTeamSync, rowHoldingOtherSubscription, upsertWorkspaceSubscriptionFromStripe } from './billingSubjects'
import { updateUserBilling, type UserBillingUpdate } from '../../../repos/userBilling'
import { handleTopupCheckout } from './creditTopups'
import type { TxHandle, DeferredAfterCommit } from './types'
import { useLogger } from '../../platform/logger'
import { system } from '../../../repos/proofs'

/** Stripe's webhook writes billing state for whichever customer the event names. */
const STRIPE = system('stripe-webhook')

const log = useLogger('stripe-webhook')

/** `client_reference_id` prefix of a workspace (Team / Business) checkout. */
export const WORKSPACE_REF_PREFIX = 'workspace:'

interface CheckoutOptions {
  stripe: Stripe
  db?: TxHandle
  deferAfterCommit?: DeferredAfterCommit
}

type CheckoutResult = { matched: number, plan: PlanName | null }

const NOT_MATCHED: CheckoutResult = { matched: 0, plan: null }

/**
 * `checkout.session.completed` handler. Fires once per successful
 * checkout. Binds the Stripe customer + subscription to its subject:
 *   - `client_reference_id = <userId>` → a personal Pro subscription;
 *   - `client_reference_id = workspace:<id>` → a Team / Business
 *     workspace subscription (metadata `billing_admin_id` = who paid).
 *
 * Why fetch the subscription here (and not defer to
 * customer.subscription.updated): Stripe fires BOTH events on a
 * successful checkout, and their delivery order is NOT guaranteed. If
 * subscription.updated arrives first, its handler can't map the customer
 * yet — that is THIS handler's job. By retrieving the subscription
 * synchronously here we apply the full state in one write; later
 * subscription.updated events become idempotent no-ops.
 */
export async function handleCheckoutSessionCompleted(
  event: Stripe.CheckoutSessionCompletedEvent,
  opts: CheckoutOptions
): Promise<CheckoutResult> {
  const session = event.data.object
  // One-time top-up purchase, not a subscription.
  if (session.mode === 'payment') {
    return handleTopupCheckout(session, opts)
  }
  const ref = session.client_reference_id ?? ''
  if (ref.startsWith(WORKSPACE_REF_PREFIX)) {
    return bindWorkspaceCheckout(session, ref.slice(WORKSPACE_REF_PREFIX.length), opts)
  }
  return bindPersonalCheckout(session, ref, opts)
}

/** A Team / Business checkout: the workspace's subscription row, its team budget after commit. */
async function bindWorkspaceCheckout(session: Stripe.Checkout.Session, workspaceId: string, opts: CheckoutOptions): Promise<CheckoutResult> {
  const customerId = stripeId(session.customer)
  const subscriptionId = stripeId(session.subscription)
  if (!workspaceId || !customerId || !subscriptionId) {
    const msg = `[stripe/webhook] workspace checkout without workspace / customer / subscription: session=${session.id}`
    log.warn('workspace checkout without workspace / customer / subscription', { sessionId: session.id })
    Sentry.captureMessage(msg, { level: 'warning', tags: { component: 'stripeWebhook', event: 'checkout_workspace_incomplete' } })
    return NOT_MATCHED
  }
  const sub = await opts.stripe.subscriptions.retrieve(subscriptionId)
  const identity = await identifyItem(opts.stripe, sub.items.data[0])
  if (!isWorkspaceIdentity(identity)) {
    warnUnknownPrice('checkout (workspace)', sub.items.data[0]?.price?.id, `session=${session.id}`)
    return NOT_MATCHED
  }
  // A second completed Checkout while the first subscription is still
  // live: cancel + refund the new one, keep the first.
  const holder = await rowHoldingOtherSubscription(opts.db, workspaceId, sub.id)
  if (holder && await findLiveSubscription(opts.stripe, holder.stripeSubscriptionId)) {
    await cancelDuplicateWorkspaceSubscription(opts.stripe, sub, workspaceId)
    return NOT_MATCHED
  }
  const adminRaw = Number(session.metadata?.billing_admin_id)
  await upsertWorkspaceSubscriptionFromStripe(opts.db, {
    workspaceId,
    sub,
    identity,
    customerId,
    billingAdminId: Number.isInteger(adminRaw) && adminRaw > 0 ? adminRaw : null
  })
  deferWorkspaceTeamSync(opts.deferAfterCommit, workspaceId)
  return { matched: 1, plan: identity.plan }
}

/** A personal (Pro) checkout: customer, subscription, plan and period on the user row. */
async function bindPersonalCheckout(session: Stripe.Checkout.Session, ref: string, opts: CheckoutOptions): Promise<CheckoutResult> {
  const customerId = stripeId(session.customer)
  const subscriptionId = stripeId(session.subscription)
  const userId = ref ? Number(ref) : null
  if (!userId || Number.isNaN(userId)) {
    const msg = `[stripe/webhook] checkout.session.completed with no client_reference_id: session=${session.id}`
    log.warn('checkout.session.completed with no client_reference_id', { sessionId: session.id })
    Sentry.captureMessage(msg, {
      level: 'warning',
      tags: { component: 'stripeWebhook', event: 'checkout_missing_client_ref' }
    })
    return NOT_MATCHED
  }
  if (!customerId) {
    const msg = `[stripe/webhook] checkout.session.completed missing customer: session=${session.id}`
    log.warn('checkout.session.completed missing customer', { sessionId: session.id })
    Sentry.captureMessage(msg, {
      level: 'warning',
      tags: { component: 'stripeWebhook', event: 'checkout_missing_customer' }
    })
    return NOT_MATCHED
  }

  // Non-subscription checkouts (one-off purchases) have no subscription
  // to read. Still stamp the customer id so future subscription flows can
  // reuse the same customer record.
  if (!subscriptionId) {
    const matched = await updateUserBilling(STRIPE, {
      where: { id: userId },
      set: { stripeCustomerId: customerId }
    }, opts.db)
    return { matched, plan: null }
  }

  // Fetch the full subscription. If this fails (Stripe API blip), we
  // throw → webhook returns 500 → Stripe retries with backoff.
  const sub = await opts.stripe.subscriptions.retrieve(subscriptionId)
  const item = sub.items.data[0]
  const identity = await identifyItem(opts.stripe, item)
  // A personal customer only ever holds Pro; anything else is logged and
  // the plan left alone (customer/sub ids are still stamped so ops can
  // reconcile).
  const plan: PersonalPlanName | null = identity?.plan === 'pro' ? 'pro' : null
  if (!plan) warnUnknownPrice('checkout', item?.price?.id, `session=${session.id}`)
  const period = subscriptionPeriod(sub)

  const setFields: UserBillingUpdate['set'] = {
    stripeCustomerId: customerId,
    stripeSubscriptionId: subscriptionId
  }
  if (plan) setFields.plan = plan
  if (identity) setFields.billingCurrency = identity.currency
  if (period.start) setFields.stripeCurrentPeriodStart = period.start
  if (period.end) setFields.planValidUntil = period.end

  const matched = await updateUserBilling(STRIPE, {
    where: { id: userId },
    set: setFields
  }, opts.db)

  // Sync the LiteLLM virtual-key budget to the new plan — deferred until
  // after the surrounding TX commits: calling `updateUserKeyBudget` inline
  // would self-deadlock against the row lock held by the UPDATE above.
  if (plan && opts.deferAfterCommit) {
    opts.deferAfterCommit.push(async () => {
      try {
        await updateUserKeyBudget(userId, plan)
      } catch (e) {
        log.warn('LiteLLM key budget sync failed', { userId, plan, err: e })
        Sentry.captureException(e, {
          tags: { component: 'stripeWebhook', event: 'litellm_key_sync_failed', userId: String(userId) }
        })
      }
    })
  }

  return { matched, plan }
}
