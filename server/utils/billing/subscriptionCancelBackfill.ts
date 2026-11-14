import type Stripe from 'stripe'
import { backfillUserPlanCancelAt, listUserSubscriptionsWithoutCancelState } from '../../repos/userBilling'
import { backfillWorkspaceCancelAt, listWorkspaceSubscriptionsWithoutCancelState } from '../../repos/workspaceSubscriptions'
import { system } from '../../repos/proofs'
import { subscriptionCancelAt } from './stripeEvents/stripeObjects'
import { useStripeClient } from './stripeClient'
import { useLogger } from '../platform/logger'

const log = useLogger('subscription-cancel-backfill')
const STRIPE = system('stripe-webhook')

/**
 * The end date of a cancelled subscription comes with its
 * `customer.subscription.*` events. A row that no event has written since
 * (`subscription_event_at` is null) can hold a cancellation the app never
 * saw, and the UI would say "Renews on" until the next event. Ask Stripe
 * for those rows and store the end date it reports. Only the end date is
 * written, and only while no event has written the row; a subscription that
 * still renews stays as it is and is asked again on the next run, until an
 * event writes the row.
 */
export async function backfillSubscriptionCancelDates(stripe: Stripe | null = useStripeClient()): Promise<{ checked: number, updated: number, failed: number }> {
  const summary = { checked: 0, updated: 0, failed: 0 }
  if (!stripe) return summary

  const users = await listUserSubscriptionsWithoutCancelState(STRIPE)
  const workspaces = await listWorkspaceSubscriptionsWithoutCancelState(STRIPE)
  const work = [
    ...users.map(u => ({ subscriptionId: u.subscriptionId, store: (at: Date) => backfillUserPlanCancelAt(STRIPE, u.userId, u.subscriptionId, at) })),
    ...workspaces.map(w => ({ subscriptionId: w.subscriptionId, store: (at: Date) => backfillWorkspaceCancelAt(STRIPE, w.workspaceId, w.subscriptionId, at) }))
  ]
  for (const item of work) {
    summary.checked++
    try {
      const cancelAt = subscriptionCancelAt(await stripe.subscriptions.retrieve(item.subscriptionId))
      if (cancelAt && await item.store(cancelAt) > 0) summary.updated++
    } catch (e) {
      summary.failed++
      log.warn('could not read the subscription from Stripe', { subscriptionId: item.subscriptionId, err: e })
    }
  }
  return summary
}
