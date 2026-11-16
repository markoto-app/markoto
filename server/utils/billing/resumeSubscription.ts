import type Stripe from 'stripe'
import * as Sentry from '@sentry/nuxt'
import { apiError } from '../api/apiError'
import { stripeResponseTime } from './stripeEvents/eventAge'
import { findLiveSubscription } from './stripePlanChange'
import { useLogger } from '../platform/logger'

const log = useLogger('billing')

// Taking back a cancellation ("Resume plan") of a subscription that was
// cancelled to its end but still runs: the personal Pro plan
// (`POST /api/billing/resume`) and a workspace's Team / Business plan
// (`POST /api/workspaces/:wsId/billing/resume`). The
// `customer.subscription.updated` webhook writes the same state; the
// callers write it locally at once so the page shows it.

/**
 * The update that keeps a cancelled subscription running, or null when it
 * is not cancelled. The Stripe portal cancels either to the period end
 * (`cancel_at_period_end`) or at a date (`cancel_at`); each is undone on
 * its own field (Stripe refuses both in one call).
 */
export function resumeUpdateParams(sub: Pick<Stripe.Subscription, 'cancel_at' | 'cancel_at_period_end'>): Stripe.SubscriptionUpdateParams | null {
  if (sub.cancel_at_period_end) return { cancel_at_period_end: false }
  if (sub.cancel_at) return { cancel_at: '' }
  return null
}

export interface ResumedSubscription {
  /** False: the subscription was not cancelled, nothing changed. */
  resumed: boolean
  /** Stripe's time just before the change: an event older than it is of the cancelled state. */
  changedAt: Date
}

/**
 * Resume the recorded subscription. 409 `billing/no-subscription` when
 * there is no live one (it already ended: buy a new plan instead).
 */
export async function resumeRecordedSubscription(
  stripe: Stripe,
  subscriptionId: string | null,
  tags: Record<string, string>
): Promise<ResumedSubscription> {
  let sub: Stripe.Subscription | null
  try {
    sub = await findLiveSubscription(stripe, subscriptionId)
  } catch (e) {
    log.error('subscription probe failed', { ...tags, err: e })
    Sentry.captureException(e, { tags: { component: 'billing', event: 'subscription_probe_failed', ...tags } })
    throw apiError('billing/subscription-check-failed')
  }
  if (!sub) throw apiError('billing/no-subscription')
  const changedAt = stripeResponseTime(sub)
  const params = resumeUpdateParams(sub)
  if (!params) return { resumed: false, changedAt }
  try {
    await stripe.subscriptions.update(sub.id, params)
  } catch (e) {
    log.error('resuming the subscription failed', { ...tags, err: e })
    Sentry.captureException(e, { tags: { component: 'billing', event: 'subscription_resume_failed', ...tags } })
    throw apiError('billing/plan-change-failed')
  }
  return { resumed: true, changedAt }
}
