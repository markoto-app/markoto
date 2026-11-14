import type Stripe from 'stripe'
import * as Sentry from '@sentry/nuxt'
import { isWorkspacePlan, type WorkspacePlanName } from '~~/shared/config/tiers'
import type { PriceIdentity } from '~~/shared/config/pricing'
import { identifyStripePrice } from '../stripePrices'
import { useLogger } from '../../platform/logger'

// Reading Stripe objects across API versions: what a subscription item
// sells, period anchors, the subscription an invoice bills.

const log = useLogger('stripe-webhook')

/**
 * What a subscription's first item sells (plan / interval / currency),
 * via the price catalogue (server/utils/billing/stripePrices.ts): the
 * `NUXT_STRIPE_PRICE_IDS` overrides, then the price's lookup key (always
 * on webhook payloads), then the cached catalogue. `null` = not one of
 * our prices: callers log + skip rather than mis-assign a plan.
 */
export async function identifyItem(
  stripe: Stripe | null,
  item: { price?: { id?: string | null, lookup_key?: string | null } | null } | null | undefined
): Promise<PriceIdentity | null> {
  return identifyStripePrice(stripe, item?.price ?? null)
}

/**
 * Unix seconds → Date, for a timestamp field read off a Stripe object
 * whose presence depends on the API version.
 */
function stripeTime(value: unknown): Date | null {
  return typeof value === 'number' && value > 0 ? new Date(value * 1000) : null
}

/**
 * Current billing period of a subscription. API 2025-03-31.basil keeps it
 * on the item (`items.data[].current_period_*`); the pinned
 * 2025-01-27.acacia version has it on the subscription itself. Read both,
 * item first, so the period is never lost to a version difference.
 */
export function subscriptionPeriod(sub: Stripe.Subscription): { start: Date | null, end: Date | null } {
  const item = sub.items.data[0]
  const start = item && 'current_period_start' in item ? stripeTime(item.current_period_start) : null
  const end = item && 'current_period_end' in item ? stripeTime(item.current_period_end) : null
  return {
    start: start ?? ('current_period_start' in sub ? stripeTime(sub.current_period_start) : null),
    end: end ?? ('current_period_end' in sub ? stripeTime(sub.current_period_end) : null)
  }
}

/**
 * When a cancelled subscription ends, or null while it renews. A portal
 * cancellation sets `cancel_at_period_end` (the period end is the date);
 * a scheduled cancellation sets `cancel_at` itself.
 */
export function subscriptionCancelAt(sub: Stripe.Subscription): Date | null {
  const at = stripeTime(sub.cancel_at)
  if (at) return at
  return sub.cancel_at_period_end ? subscriptionPeriod(sub).end : null
}

/**
 * The subscription an invoice bills, or null for a one-off invoice.
 * basil: `parent.subscription_details.subscription`; acacia (pinned):
 * `invoice.subscription`.
 */
export function invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  const parentRef = invoice.parent?.subscription_details?.subscription
  const ref: unknown = parentRef ?? ('subscription' in invoice ? invoice.subscription : null)
  if (typeof ref === 'string') return ref
  if (ref && typeof ref === 'object' && 'id' in ref && typeof ref.id === 'string') return ref.id
  return null
}

/**
 * The service period an invoice pays for: the latest line-item period.
 * NOT `invoice.period_start/_end`: for a renewal those describe when
 * items could be added (the period just ended), so writing them would
 * set `valid_until` to the renewal moment and end the plan.
 */
export function invoiceServicePeriod(invoice: Stripe.Invoice): { start: Date, end: Date } | null {
  let best: { start: Date, end: Date } | null = null
  for (const line of invoice.lines?.data ?? []) {
    const start = stripeTime(line.period?.start)
    const end = stripeTime(line.period?.end)
    if (start && end && (!best || end > best.end)) best = { start, end }
  }
  return best
}

export function warnUnknownPrice(where: string, priceId: string | null | undefined, ref: string): void {
  const msg = `[stripe/webhook] ${where} unknown price: ${priceId ?? 'none'} (${ref})`
  log.warn('unknown price', { where, priceId: priceId ?? null, ref })
  Sentry.captureMessage(msg, { level: 'warning', tags: { component: 'stripeWebhook', event: 'unknown_price' } })
}

export function isWorkspaceIdentity(identity: PriceIdentity | null): identity is PriceIdentity & { plan: WorkspacePlanName } {
  return identity !== null && isWorkspacePlan(identity.plan)
}

/** The id behind a Stripe reference that is either an id or an expanded object. */
export function stripeId(ref: string | { id: string } | null | undefined): string | null {
  return typeof ref === 'string' ? ref : ref?.id ?? null
}
