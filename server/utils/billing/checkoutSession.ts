import { useEnv } from '~~/shared/env/load'

/** Who the buyer pays and who handles the sales tax of a Checkout Session. */
export type CheckoutTaxMode = 'managed_payments' | 'stripe_tax' | 'none'

/**
 * The tax mode of new Checkout Sessions.
 *
 * - `managed_payments` (`NUXT_STRIPE_MANAGED_PAYMENTS=true`): Stripe Managed
 *   Payments sells as merchant of record ("Sold through Link"). Stripe
 *   calculates and remits the tax, collects the business VAT id and applies
 *   reverse charge itself, so no tax field of ours may be sent.
 * - `stripe_tax` (`NUXT_STRIPE_AUTOMATIC_TAX=true`): we are the seller and
 *   Stripe Tax calculates the tax.
 * - `none`: prices as they are, no tax handling (self-hosted billing).
 *
 * Managed Payments wins when both are set: Stripe refuses `automatic_tax`
 * on a Managed Payments session.
 */
export function checkoutTaxMode(): CheckoutTaxMode {
  const billing = useEnv().billing
  if (billing.stripeManagedPayments) return 'managed_payments'
  if (billing.stripeAutomaticTax) return 'stripe_tax'
  return 'none'
}

/** True when paid plans are sold through Stripe Managed Payments (Stripe / Link is the merchant of record). */
export function managedPaymentsEnabled(): boolean {
  return checkoutTaxMode() === 'managed_payments'
}

/**
 * The tax fields of a Checkout Session (subscription or one-off payment).
 *
 * Managed Payments: only `managed_payments: { enabled: true }`. Its update
 * guide lists what must not be sent with it: `automatic_tax`,
 * `tax_id_collection`, `customer_update`, `adaptive_pricing` (always on),
 * `subscription_data.default_tax_rates` / `.invoice_settings`,
 * `invoice_creation`, `payment_method_types` / `_configuration`,
 * `excluded_payment_method_types`, shipping, Connect fields and
 * `payment_intent_data.statement_descriptor*` / `.receipt_email`. None of
 * them is built anywhere else either. Billing address and name are
 * collected by Stripe.
 *
 * Stripe Tax: `automatic_tax` hard-errors unless Stripe Tax is activated
 * with an origin address. With an existing customer Stripe also needs
 * `customer_update` to save the collected address and name back;
 * `tax_id_collection` lets business buyers enter a VAT id (reverse charge).
 */
export function checkoutTaxFields(existingCustomer: boolean) {
  const mode = checkoutTaxMode()
  if (mode === 'managed_payments') return { managed_payments: { enabled: true } }
  if (mode === 'none') return {}
  return {
    automatic_tax: { enabled: true },
    billing_address_collection: 'required' as const,
    tax_id_collection: { enabled: true },
    ...(existingCustomer ? { customer_update: { address: 'auto' as const, name: 'auto' as const } } : {})
  }
}
