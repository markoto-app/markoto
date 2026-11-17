import type Stripe from 'stripe'
import { useEnv } from '~~/shared/env/load'
import { getWorkspaceSubscription } from '../../repos/workspaceSubscriptions'
import { safeSendTransactionalEmail } from '../email/sendEmail'
import { useLogger } from '../platform/logger'
import { subjectForCustomer } from './stripeEvents/billingSubjects'
import { stripeId } from './stripeEvents/stripeObjects'

const log = useLogger('billing-refund-notice')

// A short notice to the operator for every refund (`charge.refunded`).
// Under Stripe Managed Payments, Stripe / Link refunds buyers on its own
// (the dashboard is set to "refund automatically, no email"), so this is
// how the operator learns about it. Sent after the webhook's transaction
// committed; the webhook's event-id dedup makes it once per event. Hosted
// ops alerts (Telegram) are a host-side script the app can't reach, so
// the notice is an email to `NUXT_BILLING_NOTIFY_EMAIL`.

export interface RefundFacts {
  chargeId: string
  paymentIntentId: string | null
  livemode: boolean
  customerEmail: string | null
  /** What was bought, e.g. `AI credits, pack 25` or `team (workspace ws_1)`. */
  purchase: string
  /** This refund in minor units (the latest one), and the charge's totals. */
  refundedNow: number | null
  refundedTotal: number
  chargeAmount: number
  currency: string
  /** What the buyer saw, when Stripe converted the price (Adaptive Pricing). */
  presentment: { amount: number, currency: string } | null
  reason: string | null
}

/** `12.50 EUR` from minor units (EUR and CHF have two decimals). */
function formatMinor(amount: number, currency: string): string {
  return `${(amount / 100).toFixed(2)} ${currency.toUpperCase()}`
}

/** The Stripe dashboard page of the payment (test-mode path for test payments). */
export function dashboardPaymentUrl(facts: Pick<RefundFacts, 'paymentIntentId' | 'chargeId' | 'livemode'>): string {
  const base = facts.livemode ? 'https://dashboard.stripe.com' : 'https://dashboard.stripe.com/test'
  return `${base}/payments/${encodeURIComponent(facts.paymentIntentId ?? facts.chargeId)}`
}

/** Subject and plain-text body of the notice. */
export function buildRefundNotice(facts: RefundFacts): { subject: string, body: string } {
  const now = facts.refundedNow === null ? formatMinor(facts.refundedTotal, facts.currency) : formatMinor(facts.refundedNow, facts.currency)
  const lines = [
    'A payment was refunded.',
    '',
    `Customer: ${facts.customerEmail ?? '(no email on the payment)'}`,
    `Purchase: ${facts.purchase}`,
    `Refunded now: ${now}`,
    `Refunded in total: ${formatMinor(facts.refundedTotal, facts.currency)} of ${formatMinor(facts.chargeAmount, facts.currency)}`,
    ...(facts.presentment ? [`Paid by the buyer: ${formatMinor(facts.presentment.amount, facts.presentment.currency)}`] : []),
    `Reason: ${facts.reason ?? 'not given'}`,
    '',
    `Stripe: ${dashboardPaymentUrl(facts)}`
  ]
  return { subject: `[markoto billing] Refund ${now}: ${facts.purchase}`, body: lines.join('\n') }
}

/**
 * The facts of a refunded charge. Every lookup beyond the event payload
 * is best-effort: a notice with "unknown" beats none.
 */
async function collectRefundFacts(stripe: Stripe | null, charge: Stripe.Charge): Promise<RefundFacts> {
  const paymentIntentId = stripeId(charge.payment_intent)
  const latestRefund = await latestRefundOf(stripe, charge.id)
  return {
    chargeId: charge.id,
    paymentIntentId,
    livemode: charge.livemode,
    customerEmail: charge.billing_details?.email ?? charge.receipt_email ?? null,
    purchase: await purchaseOf(stripe, charge, paymentIntentId),
    refundedNow: latestRefund?.amount ?? null,
    refundedTotal: charge.amount_refunded,
    chargeAmount: charge.amount,
    currency: charge.currency,
    presentment: charge.presentment_details
      ? { amount: charge.presentment_details.presentment_amount, currency: charge.presentment_details.presentment_currency }
      : null,
    reason: latestRefund?.reason ?? null
  }
}

async function latestRefundOf(stripe: Stripe | null, chargeId: string): Promise<Stripe.Refund | null> {
  if (!stripe) return null
  try {
    return (await stripe.refunds.list({ charge: chargeId, limit: 1 })).data[0] ?? null
  } catch (e) {
    log.warn('refund lookup failed', { chargeId, err: e })
    return null
  }
}

/** A top-up names its pack (payment intent metadata, set by our checkout); a subscription the subject's plan. */
async function purchaseOf(stripe: Stripe | null, charge: Stripe.Charge, paymentIntentId: string | null): Promise<string> {
  try {
    const meta = stripe && paymentIntentId ? (await stripe.paymentIntents.retrieve(paymentIntentId)).metadata : charge.metadata
    if (meta?.kind === 'topup') return `AI credits, pack ${meta.pack ?? '?'} (${meta.subject_type ?? '?'} ${meta.subject_id ?? '?'})`
    const customerId = stripeId(charge.customer)
    const subject = customerId ? await subjectForCustomer(customerId, undefined) : null
    if (subject?.kind === 'user') return `pro (user ${subject.userId})`
    if (subject?.kind === 'workspace') {
      const plan = (await getWorkspaceSubscription(subject.workspaceId))?.plan ?? 'workspace plan'
      return `${plan} (workspace ${subject.workspaceId})`
    }
  } catch (e) {
    log.warn('refund purchase lookup failed', { chargeId: charge.id, err: e })
  }
  return 'unknown'
}

/** Send the notice to `NUXT_BILLING_NOTIFY_EMAIL`; without one, log it. Never throws. */
export async function sendRefundNotice(stripe: Stripe | null, charge: Stripe.Charge): Promise<void> {
  try {
    const facts = await collectRefundFacts(stripe, charge)
    const to = useEnv().billing.billingNotifyEmail ?? null
    log.info('refund issued', { chargeId: facts.chargeId, amount: facts.refundedNow ?? facts.refundedTotal, currency: facts.currency, notified: to !== null })
    if (!to) return
    const { subject, body } = buildRefundNotice(facts)
    await safeSendTransactionalEmail({
      kind: 'billing.refund_notice',
      to,
      locale: null,
      subject,
      body,
      metadata: { chargeId: facts.chargeId, currency: facts.currency, livemode: facts.livemode }
    })
  } catch (e) {
    log.error('refund notice failed', { chargeId: charge.id, err: e })
  }
}
