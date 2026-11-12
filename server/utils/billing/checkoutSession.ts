import { useEnv } from '~~/shared/env/load'

/**
 * Stripe Tax fields of a Checkout Session. Opt-in via
 * NUXT_STRIPE_AUTOMATIC_TAX=1: `automatic_tax` hard-errors unless Stripe Tax
 * is activated and an origin address is set in the dashboard. With an
 * existing customer Stripe also needs `customer_update` to save the
 * collected address/name back. `tax_id_collection` lets B2B customers enter
 * a VAT id (EU reverse charge).
 */
export function checkoutTaxFields(existingCustomer: boolean) {
  const taxEnabled = ['1', 'true', 'yes'].includes(String(useEnv().billing.stripeAutomaticTax || '').toLowerCase())
  if (!taxEnabled) return {}
  return {
    automatic_tax: { enabled: true },
    billing_address_collection: 'required' as const,
    tax_id_collection: { enabled: true },
    ...(existingCustomer ? { customer_update: { address: 'auto' as const, name: 'auto' as const } } : {})
  }
}
