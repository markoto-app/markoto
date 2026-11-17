import type Stripe from 'stripe'
import * as Sentry from '@sentry/nuxt'
import { stampFirstStripeCustomer } from '../../../repos/userBilling'
import type { PlanName } from '~~/shared/config/tiers'
import { isCurrency, isTopupPackId, topupPack, TOPUP_VALIDITY_MONTHS } from '~~/shared/config/pricing'
import { insertCreditGrant, refundCreditGrant, type CreditSubject } from '../../../repos/aiCreditGrants'
import { recomputeCreditBudget } from '../aiCredits'
import type { TxHandle, DeferredAfterCommit, StripeHandlerOptions } from './types'
import { sendRefundNotice } from '../refundNotice'
import { useLogger } from '../../platform/logger'
import { system } from '../../../repos/proofs'

/** Stripe's webhook writes billing state for whichever customer the event names. */
const STRIPE = system('stripe-webhook')

// AI credit top-ups: a paid (or delayed-paid) top-up Checkout grants
// credit, a refund takes the refunded share back.

const log = useLogger('stripe-webhook')

/**
 * A paid credit top-up: record the grant (once per payment intent)
 * and raise the subject's AI budget after commit. The subject comes from
 * the session metadata our checkout set (`subject_type` / `subject_id`);
 * a personal buyer's first customer id is stamped on the user.
 */
export async function handleTopupCheckout(
  session: Stripe.Checkout.Session,
  opts: { db?: TxHandle, deferAfterCommit?: DeferredAfterCommit }
): Promise<{ matched: number, plan: PlanName | null }> {
  const meta = session.metadata ?? {}
  const pack = meta.pack
  const subjectType = meta.subject_type
  const subjectId = meta.subject_id
  const paymentIntent = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id ?? null
  const currency = (session.currency ?? '').toLowerCase()
  if (meta.kind !== 'topup' || !isTopupPackId(pack) || (subjectType !== 'user' && subjectType !== 'workspace') || !subjectId || !paymentIntent || !isCurrency(currency)) {
    const msg = `[stripe/webhook] payment checkout that isn't a valid top-up: session=${session.id}`
    log.warn('payment checkout is not a valid top-up', { sessionId: session.id })
    Sentry.captureMessage(msg, { level: 'warning', tags: { component: 'stripeWebhook', event: 'topup_invalid' } })
    return { matched: 0, plan: null }
  }
  // Delayed methods (SEPA Direct Debit, …) complete the Checkout with
  // `unpaid`; the credit is granted on `checkout.session.async_payment_succeeded`.
  if (session.payment_status !== 'paid') return { matched: 0, plan: null }
  const db = opts.db
  const subject: CreditSubject = { type: subjectType, id: subjectId }
  const expiresAt = new Date()
  expiresAt.setUTCMonth(expiresAt.getUTCMonth() + TOPUP_VALIDITY_MONTHS)
  const inserted = await insertCreditGrant(STRIPE, {
    subject,
    pack,
    amountUsd: topupPack(pack).creditUsd,
    amountPaid: session.amount_total ?? 0,
    currency,
    stripePaymentIntentId: paymentIntent,
    stripeCheckoutSessionId: session.id,
    expiresAt
  }, db)
  const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id ?? null
  if (subjectType === 'user' && customerId) {
    await stampFirstStripeCustomer(STRIPE, db, Number(subjectId), customerId, currency)
  }
  if (inserted) opts.deferAfterCommit?.push(() => recomputeCreditBudget(subject))
  return { matched: inserted ? 1 : 0, plan: null }
}

/**
 * `checkout.session.async_payment_succeeded`: a top-up paid with a
 * delayed method (e.g. SEPA Direct Debit) has been paid, grant it now.
 * `checkout.session.completed` saw `payment_status: 'unpaid'` and
 * granted nothing. Idempotent like every grant (unique payment intent).
 * Subscription Checkouts need nothing here: their state comes from the
 * subscription events.
 */
export async function handleCheckoutAsyncPaymentSucceeded(
  event: Stripe.CheckoutSessionAsyncPaymentSucceededEvent,
  opts: { db?: TxHandle, deferAfterCommit?: DeferredAfterCommit }
): Promise<{ matched: number, plan: PlanName | null }> {
  const session = event.data.object
  if (session.mode !== 'payment') return { matched: 0, plan: null }
  return handleTopupCheckout(session, opts)
}

/**
 * `checkout.session.async_payment_failed`: a delayed top-up payment
 * failed. Nothing was granted; logged for support.
 */
export function handleCheckoutAsyncPaymentFailed(event: Stripe.CheckoutSessionAsyncPaymentFailedEvent): { matched: number } {
  const session = event.data.object
  if (session.mode !== 'payment') return { matched: 0 }
  const msg = `[stripe/webhook] delayed top-up payment failed: session=${session.id}`
  log.warn('delayed top-up payment failed', { sessionId: session.id })
  Sentry.captureMessage(msg, { level: 'warning', tags: { component: 'stripeWebhook', event: 'topup_async_payment_failed' } })
  return { matched: 0 }
}

/**
 * `charge.refunded`: a refunded top-up loses the refunded share of its
 * credit (credits already used stay used). Every refund, of a top-up or a
 * plan, is also reported to the operator after commit (`sendRefundNotice`);
 * the event-id dedup sends it once. With Adaptive Pricing the charge's
 * `amount` / `currency` stay in the price's currency (the buyer's own is
 * only in `presentment_details`), so the refunded share is exact.
 */
export async function handleChargeRefunded(
  event: Stripe.ChargeRefundedEvent,
  opts: Partial<StripeHandlerOptions> = {}
): Promise<{ matched: number }> {
  const charge = event.data.object
  const { db, deferAfterCommit } = opts
  if (charge.amount_refunded > 0) {
    deferAfterCommit?.push(() => sendRefundNotice(opts.stripe ?? null, charge))
  }
  const paymentIntent = typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id ?? null
  if (!paymentIntent || charge.amount <= 0) return { matched: 0 }
  const subject = await refundCreditGrant(STRIPE, paymentIntent, charge.amount_refunded / charge.amount, db)
  if (!subject) return { matched: 0 }
  deferAfterCommit?.push(() => recomputeCreditBudget(subject))
  return { matched: 1 }
}
