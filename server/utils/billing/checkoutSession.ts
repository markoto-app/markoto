import type { H3Event } from 'h3'
import { useEnv } from '~~/shared/env/load'
import { saleMaybeAllowed, salesRestricted, type SalesRegionRule } from '~~/shared/config/salesRegions'
import type { BuyerLocationResponse } from '~~/shared/contracts/billing'
import { apiError } from '../api/apiError'
import { getClientIp } from '../platform/clientIp'
import { isBillingEnabled } from './billingMode'
import { countryOfIp } from './ipCountry'

/** Stripe Tax on (`NUXT_STRIPE_AUTOMATIC_TAX`) and billing on: the tax-compliance rules apply. */
export function taxComplianceActive(): boolean {
  return isBillingEnabled() && useEnv().billing.stripeAutomaticTax
}

/** Who may buy where (`shared/config/salesRegions.ts`); no restriction unless tax compliance is active. */
export function salesRegionRule(): SalesRegionRule {
  if (!taxComplianceActive()) return { b2cAllowed: [], b2bAllowed: [], blocked: [] }
  const env = useEnv().billing
  return { b2cAllowed: env.b2cAllowedCountries, b2bAllowed: env.b2bAllowedCountries, blocked: env.blockedCountries }
}

/** The request's IP country (bundled offline database); null when tax compliance is off or unknown. */
export async function requestIpCountry(event: H3Event): Promise<string | null> {
  if (!taxComplianceActive()) return null
  return countryOfIp(getClientIp(event))
}

/** What the pricing page shows before Checkout (`GET /api/billing/buyer-location`). */
export async function buyerLocation(event: H3Event): Promise<BuyerLocationResponse> {
  const rule = salesRegionRule()
  if (!taxComplianceActive() || !salesRestricted(rule)) return { active: false }
  return {
    active: true,
    country: await requestIpCountry(event),
    b2cAllowed: [...rule.b2cAllowed],
    b2bAllowed: [...rule.b2bAllowed],
    blocked: [...rule.blocked]
  }
}

export interface CheckoutBuyer {
  /** The country the buyer picked on the page; absent = the IP country. */
  country?: string | null
  /** The buyer says they buy for a company with a VAT / tax ID. */
  business?: boolean
}

export interface CheckoutCompliance {
  /** Session + subscription / payment metadata: the IP country as location evidence. */
  metadata: Record<string, string>
  /** A declared business purchase: Checkout makes the tax ID mandatory. */
  taxIdRequired: boolean
}

/**
 * Before a Checkout Session: the buyer's region must be one we may sell to
 * (`saleMaybeAllowed`; the webhook judges the exact billing address and
 * refunds what slipped through), and the IP country rides along as evidence.
 * 409 `billing/region-unavailable` otherwise. A no-op unless tax compliance
 * is active.
 */
export async function checkoutCompliance(event: H3Event, buyer: CheckoutBuyer = {}): Promise<CheckoutCompliance> {
  if (!taxComplianceActive()) return { metadata: {}, taxIdRequired: false }
  const ipCountry = await requestIpCountry(event)
  const business = buyer.business === true
  const country = buyer.country?.toUpperCase() ?? ipCountry
  if (!saleMaybeAllowed(salesRegionRule(), country, business)) {
    throw apiError('billing/region-unavailable', { country: country ?? undefined, business })
  }
  return { metadata: ipCountry ? { ip_country: ipCountry } : {}, taxIdRequired: business }
}

/** Top-up Checkout metadata: the IP country as location evidence (no region pre-check). */
export async function topupEvidence(event: H3Event): Promise<Record<string, string>> {
  const ipCountry = await requestIpCountry(event)
  return ipCountry ? { ip_country: ipCountry } : {}
}

/**
 * Stripe Tax fields of a Checkout Session. Opt-in via
 * NUXT_STRIPE_AUTOMATIC_TAX=1: `automatic_tax` hard-errors unless Stripe Tax
 * is activated and an origin address is set in the dashboard. With an
 * existing customer Stripe also needs `customer_update` to save the
 * collected address/name back. `tax_id_collection` lets B2B customers enter
 * a VAT id (EU reverse charge); a declared business purchase must
 * (`required: 'if_supported'`: wherever Stripe knows the country's tax ID).
 */
export function checkoutTaxFields(existingCustomer: boolean, opts: { taxIdRequired?: boolean } = {}) {
  if (!useEnv().billing.stripeAutomaticTax) return {}
  return {
    automatic_tax: { enabled: true },
    billing_address_collection: 'required' as const,
    tax_id_collection: opts.taxIdRequired ? { enabled: true, required: 'if_supported' as const } : { enabled: true },
    ...(existingCustomer ? { customer_update: { address: 'auto' as const, name: 'auto' as const } } : {})
  }
}
