import type Stripe from 'stripe'
import type { PriceIdentity } from '~~/shared/config/pricing'
import { recordSubscriptionEvent, type SubscriptionEventKind } from '../../../repos/subscriptionEvents'
import { system } from '../../../repos/proofs'
import { subscriptionCancelAt } from './stripeObjects'
import { eventTime } from './eventAge'
import type { CustomerSubject } from './billingSubjects'
import type { TxHandle } from './types'

// The subscription history (`subscription_events`) written from the
// subscription webhook events: what Stripe says happened, once per event.
// Recorded whether or not the event changes the stored state (a `created`
// event that its checkout overtook still marks the start), but only for a
// customer we know and a price that is ours.

const STRIPE = system('stripe-webhook')

type SubscriptionEvent
  = | Stripe.CustomerSubscriptionCreatedEvent
    | Stripe.CustomerSubscriptionUpdatedEvent
    | Stripe.CustomerSubscriptionDeletedEvent

/**
 * The lifecycle steps an event stands for. An update counts as a change
 * when the price or the quantity moved, and as a cancellation scheduled /
 * taken back when the cancellation fields moved. Period renewals and
 * status changes are no step.
 */
export function subscriptionEventKinds(event: SubscriptionEvent): SubscriptionEventKind[] {
  if (event.type === 'customer.subscription.created') return ['started']
  if (event.type === 'customer.subscription.deleted') return ['ended']
  const previous = (event.data.previous_attributes ?? {}) as Record<string, unknown>
  const kinds: SubscriptionEventKind[] = []
  if ('items' in previous || 'quantity' in previous || 'plan' in previous) kinds.push('changed')
  if ('cancel_at_period_end' in previous || 'cancel_at' in previous) {
    kinds.push(subscriptionCancelAt(event.data.object) ? 'cancel_scheduled' : 'cancel_revoked')
  }
  return kinds
}

export async function recordSubscriptionHistory(
  event: SubscriptionEvent,
  subject: CustomerSubject,
  identity: PriceIdentity,
  db: TxHandle | undefined
): Promise<void> {
  const sub = event.data.object
  const seats = subject.kind === 'workspace' ? (sub.items?.data[0]?.quantity ?? 1) : 1
  for (const kind of subscriptionEventKinds(event)) {
    await recordSubscriptionEvent(STRIPE, db, {
      kind,
      subject,
      plan: identity.plan,
      interval: identity.interval,
      currency: identity.currency,
      seats,
      stripeSubscriptionId: sub.id,
      stripeEventId: event.id,
      occurredAt: eventTime(event)
    })
  }
}
