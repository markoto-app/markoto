import type Stripe from 'stripe'
import * as Sentry from '@sentry/nuxt'
import { stripeTopupPriceIdFor } from './stripePrices'
import type { Currency, TopupPackId } from '~~/shared/config/pricing'
import type { CreditSubject } from '../../repos/aiCreditGrants'

// Stripe Checkout for an AI credit top-up (WP4): `mode: 'payment'`, one
// pack, the subject in the metadata (the webhook reads it back:
// `stripeWebhook.ts#handleTopupCheckout`). Automatic tax follows
// `NUXT_STRIPE_AUTOMATIC_TAX` like subscriptions.

export async function createTopupCheckout(stripe: Stripe, args: {
  subject: CreditSubject
  pack: TopupPackId
  currency: Currency
  customer: string | null
  email: string | null
  clientReferenceId: string
  successUrl: string
  cancelUrl: string
  automaticTax: boolean
}): Promise<{ url: string, sessionId: string }> {
  const priceId = await stripeTopupPriceIdFor(stripe, args.pack, args.currency)
  if (!priceId) {
    throw createError({ statusCode: 503, message: `No Stripe price is set up for the ${args.pack} top-up (${args.currency.toUpperCase()}).` })
  }
  const metadata = { kind: 'topup', pack: args.pack, subject_type: args.subject.type, subject_id: args.subject.id }
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      client_reference_id: args.clientReferenceId,
      line_items: [{ price: priceId, quantity: 1 }],
      metadata,
      payment_intent_data: { metadata },
      success_url: args.successUrl,
      cancel_url: args.cancelUrl,
      ...(args.customer
        ? { customer: args.customer }
        : { customer_creation: 'always' as const, ...(args.email ? { customer_email: args.email } : {}) }),
      ...(args.automaticTax
        ? {
            automatic_tax: { enabled: true },
            billing_address_collection: 'required' as const,
            tax_id_collection: { enabled: true },
            ...(args.customer ? { customer_update: { address: 'auto' as const, name: 'auto' as const } } : {})
          }
        : {})
    })
    if (!session.url) throw createError({ statusCode: 502, message: 'Stripe did not return a Checkout URL' })
    return { url: session.url, sessionId: session.id }
  } catch (e) {
    if ((e as { statusCode?: number })?.statusCode) throw e
    Sentry.captureException(e, { tags: { component: 'billing', event: 'topup_checkout_failed' } })
    throw createError({ statusCode: 502, message: `Could not start checkout: ${e instanceof Error ? e.message : 'Stripe error'}` })
  }
}

export function automaticTaxEnabled(value: unknown): boolean {
  return ['1', 'true', 'yes'].includes(String(value || '').toLowerCase())
}
