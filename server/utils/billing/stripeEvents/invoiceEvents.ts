import type Stripe from 'stripe'
import * as Sentry from '@sentry/nuxt'
import { notifyWorkspaceAdmins } from '../../email/workspaceBillingEmails'
import { invoiceServicePeriod, invoiceSubscriptionId } from './stripeObjects'
import { rowHoldingOtherSubscription, subjectForCustomer } from './billingSubjects'
import { advanceUserBillingPeriod } from '../../../repos/userBilling'
import { advanceWorkspaceBillingPeriod } from '../../../repos/workspaceSubscriptions'
import type { TxHandle, DeferredAfterCommit } from './types'
import { useLogger } from '../../platform/logger'
import { system } from '../../../repos/proofs'

/** Stripe's webhook writes billing state for whichever customer the event names. */
const STRIPE = system('stripe-webhook')

// Invoices: a paid one advances the period anchors, a failed one is
// reported (Stripe retries; workspace admins hear about the first failure).

const log = useLogger('stripe-webhook')

/**
 * `invoice.paid` handler. A subscription invoice was paid (renewal, or
 * the prorated charge for added seats): advance the period anchors to
 * the service period it paid for (user or workspace). Only ever moves
 * them forward: `customer.subscription.updated` carries the same period
 * and may arrive first, and a late event of an older invoice must not
 * pull `valid_until` back.
 *
 * No LiteLLM spend reset here: spend resets are driven by the key's
 * `budget_duration` (monthly, on the 1st) so every tier, including free,
 * which has no invoice, resets uniformly.
 *
 * Skip non-subscription invoices (one-off charges, top-ups).
 */
export async function handleInvoicePaid(
  event: Stripe.InvoicePaidEvent,
  db?: TxHandle,
  _deferAfterCommit?: DeferredAfterCommit
): Promise<{ matched: number }> {
  const handle = db
  const invoice = event.data.object
  const subscriptionId = invoiceSubscriptionId(invoice)
  if (!subscriptionId) return { matched: 0 }
  const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id ?? null
  if (!customerId) return { matched: 0 }
  const period = invoiceServicePeriod(invoice)
  if (!period) return { matched: 0 }

  const subject = await subjectForCustomer(customerId, handle)
  if (subject?.kind === 'workspace') {
    if (await rowHoldingOtherSubscription(handle, subject.workspaceId, subscriptionId)) return { matched: 0 }
    return { matched: await advanceWorkspaceBillingPeriod(STRIPE, handle, subject.workspaceId, period) }
  }

  return { matched: await advanceUserBillingPeriod(STRIPE, handle, customerId, subscriptionId, period) }
}

/**
 * `invoice.payment_failed` handler. Observability-only: no downgrade
 * on first failure (Stripe retries; the subscription goes `past_due`,
 * which `customer.subscription.updated` records, and eventually
 * `customer.subscription.deleted` if every retry fails).
 */
export async function handleInvoicePaymentFailed(
  event: Stripe.InvoicePaymentFailedEvent,
  db?: TxHandle,
  deferAfterCommit?: DeferredAfterCommit
): Promise<{ matched: number }> {
  const invoice = event.data.object
  const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id ?? null
  // Team / Business: Stripe retries for about two weeks; the admins hear
  // about the FIRST failure. Personal plans: Stripe's own dunning
  // emails cover it.
  if (customerId && (invoice.attempt_count ?? 1) <= 1) {
    const subject = await subjectForCustomer(customerId, db)
    if (subject?.kind === 'workspace') {
      const workspaceId = subject.workspaceId
      deferAfterCommit?.push(async () => {
        await notifyWorkspaceAdmins({ workspaceId, kind: 'payment_failed', onceKey: `payment_failed:${invoice.id}` })
      })
    }
  }
  const msg = `[stripe/webhook] payment failed for customer=${customerId} invoice=${invoice.id} attempt=${invoice.attempt_count}`
  log.warn('payment failed', { customerId, invoiceId: invoice.id, attempt: invoice.attempt_count })
  Sentry.captureMessage(msg, {
    level: 'warning',
    tags: { component: 'stripeWebhook', event: 'invoice_payment_failed' }
  })
  return { matched: 0 }
}
