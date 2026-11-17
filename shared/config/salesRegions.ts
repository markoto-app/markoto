// Where paid plans and AI credits may be sold, and to whom.
//
// Selling a digital service makes the seller liable for VAT / sales tax in
// the buyer's country. A consumer (B2C) sale usually needs a registration
// there from the first sale; a sale to a company with a tax ID (B2B) is often
// reverse-charged, but not everywhere: the US, some Canadian provinces,
// Mexico, Japan and others still make the seller collect, or count B2B sales
// toward a registration threshold. So the operator lists the regions it can
// sell to, separately for both kinds of buyer:
//
//   NUXT_BILLING_B2C_ALLOWED_COUNTRIES  consumers (no tax ID); empty = everywhere
//   NUXT_BILLING_B2B_ALLOWED_COUNTRIES  companies with a tax ID; empty = everywhere
//   NUXT_BILLING_BLOCKED_COUNTRIES      nobody, on top of both lists
//
// An entry is an ISO 3166-1 country (`DE`) or a subdivision (`US-CA`,
// `CA-QC`), matched against the billing address Stripe collects (`country`
// + `state`). All three empty (the default, and what a self-hoster runs) =
// no restriction. The rule is applied twice: before Checkout (the pricing
// page and the checkout routes, from the IP country the buyer can change)
// and in the webhook (from the billing address): a sale that should not
// have happened is cancelled and refunded there.
//
// Planned values for markoto.app (set in the hosted environment, never a
// code default; to be confirmed against the tax registrations in place):
//   B2C: CH, LI, the EU 27 once the non-Union OSS registration is live,
//        NO, IS, AU, NZ, SG, JP, HK
//   B2B: the same plus GB (UK businesses are reverse-charged)
// Do not allowlist the whole of `US` or `CA` yet: B2B sales there count
// toward state / provincial thresholds.

/** The 27 EU member states (ISO 3166-1 alpha-2; Greece is `GR` in Stripe addresses). */
export const EU_COUNTRIES = [
  'AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'HU',
  'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK'
] as const

/** The planned hosted B2C list (documentation; the operator sets the env var). */
export const PLANNED_HOSTED_B2C_REGIONS = ['CH', 'LI', ...EU_COUNTRIES, 'NO', 'IS', 'AU', 'NZ', 'SG', 'JP', 'HK'] as const

/** The planned hosted B2B list: the B2C list plus the UK. */
export const PLANNED_HOSTED_B2B_REGIONS = [...PLANNED_HOSTED_B2C_REGIONS, 'GB'] as const

/** One list entry: `DE` or `US-CA`. Validates the env var entries. */
export const SALES_REGION_PATTERN = /^[A-Z]{2}(?:-[A-Z0-9]{1,3})?$/i

export interface SalesRegionRule {
  b2cAllowed: readonly string[]
  b2bAllowed: readonly string[]
  blocked: readonly string[]
}

export interface BuyerRegion {
  /** ISO 3166-1 alpha-2; null when unknown. */
  country: string | null
  /** Stripe's `address.state` (for the US and Canada the subdivision code). */
  state?: string | null
}

/** No list set: every buyer allowed (self-host default). */
export function salesRestricted(rule: SalesRegionRule): boolean {
  return rule.b2cAllowed.length > 0 || rule.b2bAllowed.length > 0 || rule.blocked.length > 0
}

function normalise(list: readonly string[]): string[] {
  return list.map(e => e.trim().toUpperCase()).filter(Boolean)
}

function regionKeys(region: BuyerRegion): string[] {
  const country = region.country?.trim().toUpperCase()
  if (!country) return []
  const state = region.state?.trim().toUpperCase()
  return state ? [country, `${country}-${state}`] : [country]
}

function listed(list: readonly string[], keys: readonly string[]): boolean {
  const entries = normalise(list)
  return keys.some(k => entries.includes(k))
}

/**
 * Whether a sale to this buyer is allowed, from the billing address. An
 * unknown country passes (nothing to judge; Stripe always collects one when
 * automatic tax is on).
 */
export function saleAllowed(rule: SalesRegionRule, region: BuyerRegion, hasTaxId: boolean): boolean {
  const keys = regionKeys(region)
  if (keys.length === 0) return true
  if (listed(rule.blocked, keys)) return false
  const allow = hasTaxId ? rule.b2bAllowed : rule.b2cAllowed
  return allow.length === 0 || listed(allow, keys)
}

/**
 * The same rule before Checkout, where only the country is known (from the
 * IP, or picked by the buyer): a country passes when it, or any of its
 * subdivisions, is listed. The webhook then judges the exact address.
 */
export function saleMaybeAllowed(rule: SalesRegionRule, country: string | null, hasTaxId: boolean): boolean {
  const c = country?.trim().toUpperCase()
  if (!c) return true
  if (normalise(rule.blocked).includes(c)) return false
  const allow = normalise(hasTaxId ? rule.b2bAllowed : rule.b2cAllowed)
  return allow.length === 0 || allow.some(e => e === c || e.startsWith(`${c}-`))
}
