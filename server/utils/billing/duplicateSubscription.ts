import type Stripe from 'stripe'
import * as Sentry from '@sentry/nuxt'
import { useLogger } from '../platform/logger'

const log = useLogger('billing')

/** Who the duplicate was bought for: a workspace (Team / Business) or a user (Pro). */
export type DuplicateSubscriptionSubject
  = | { kind: 'workspace', workspaceId: string }
    | { kind: 'user', userId: number }

function refundMetadata(subject: DuplicateSubscriptionSubject, subscriptionId: string): Record<string, string> {
  return subject.kind === 'workspace'
    ? { reason: 'duplicate_workspace_subscription', workspace_id: subject.workspaceId, subscription_id: subscriptionId }
    : { reason: 'duplicate_personal_subscription', user_id: String(subject.userId), subscription_id: subscriptionId }
}

function subjectFields(subject: DuplicateSubscriptionSubject): { workspaceId: string } | { userId: string } {
  return subject.kind === 'workspace' ? { workspaceId: subject.workspaceId } : { userId: String(subject.userId) }
}

/**
 * A second subscription for a subject that already has a live one (two
 * admins or two tabs each completed a Checkout, or a stale Checkout page
 * was paid). Cancel it at once and refund what its first invoice took;
 * the subject keeps the first subscription. Safe to repeat (a webhook
 * retry): a cancelled subscription is not cancelled again, and each
 * refund carries an idempotency key per payment. A refund that fails is
 * reported (error level) for a manual refund instead of failing the
 * webhook. Refunds through the API work with Managed Payments too.
 */
export async function cancelDuplicateSubscription(stripe: Stripe, sub: Stripe.Subscription, subject: DuplicateSubscriptionSubject): Promise<{ refunded: number }> {
  if (sub.status !== 'canceled' && sub.status !== 'incomplete_expired') {
    await stripe.subscriptions.cancel(sub.id, { prorate: false, invoice_now: false })
  }
  const fields = subjectFields(subject)
  let refunded = 0
  const invoiceId = typeof sub.latest_invoice === 'string' ? sub.latest_invoice : sub.latest_invoice?.id ?? null
  try {
    for (const paymentIntent of invoiceId ? await paidInvoicePaymentIntents(stripe, invoiceId) : []) {
      await stripe.refunds.create(
        { payment_intent: paymentIntent, metadata: refundMetadata(subject, sub.id) },
        { idempotencyKey: `markoto-duplicate-subscription-refund-${paymentIntent}` }
      )
      refunded++
    }
  } catch (e) {
    log.error('refund of a duplicate subscription failed: refund it manually', { subscriptionId: sub.id, ...fields, err: e })
    Sentry.captureException(e, { level: 'error', tags: { component: 'billing', event: 'duplicate_subscription_refund_failed', ...fields } })
  }
  const owner = subject.kind === 'workspace' ? `workspace ${subject.workspaceId}` : `user ${subject.userId}`
  log.warn('duplicate subscription cancelled', { subscriptionId: sub.id, ...fields, refunded })
  Sentry.captureMessage(`[billing] duplicate subscription ${sub.id} for ${owner} cancelled, ${refunded} payment(s) refunded`, {
    level: 'warning',
    tags: { component: 'billing', event: 'duplicate_subscription_cancelled', ...fields }
  })
  return { refunded }
}

/**
 * The payment intents that paid an invoice. Since basil (pinned) they are
 * listed under Invoice Payments; acacia named it on the invoice
 * (`payment_intent`, only set once paid), kept for a webhook endpoint
 * that still renders the older version.
 */
async function paidInvoicePaymentIntents(stripe: Stripe, invoiceId: string): Promise<string[]> {
  const invoice = await stripe.invoices.retrieve(invoiceId)
  if ('payment_intent' in invoice) {
    const pi: unknown = invoice.payment_intent
    const id = typeof pi === 'string' ? pi : pi && typeof pi === 'object' && 'id' in pi && typeof pi.id === 'string' ? pi.id : null
    return id && invoice.status === 'paid' ? [id] : []
  }
  const ids: string[] = []
  for await (const payment of stripe.invoicePayments.list({ invoice: invoiceId, status: 'paid' })) {
    const pi = payment.payment.payment_intent
    const id = typeof pi === 'string' ? pi : pi?.id
    if (id) ids.push(id)
  }
  return ids
}
