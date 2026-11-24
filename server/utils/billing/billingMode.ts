// Server-side accessors for the deployment's billing mode. See
// `shared/config/billingMode.ts` for the matrix of deployment shapes.
//
// Reads the typed env (shared/env), which works outside a Nitro context:
// the enforcement utils that consult it (billing resolver, knowledge
// quotas, account deletion, data export) run in the repos/unit test tiers.

import { resolveBillingMode, type BillingMode } from '~~/shared/config/billingMode'
import type { PlanName } from '~~/shared/config/tiers'
import { apiError } from '../api/apiError'

export function getBillingMode(): BillingMode {
  return resolveBillingMode()
}

export function isBillingEnabled(): boolean {
  return getBillingMode().billingEnabled
}

/** Stable machine code for every "billing is switched off" refusal. */
const BILLING_DISABLED_CODE = 'billing/disabled'

/**
 * Guard for every billing-only HTTP surface (checkout, portal, Stripe
 * webhook). When billing is off the feature
 * does not exist on this deployment, so the answer is 404, not 503:
 * 503 means "temporarily unavailable, retry", which would make Stripe
 * (or any client) retry forever against a permanent configuration
 * state. The `code` lets the client tell "billing is off" apart from
 * an ordinary missing route.
 */
export function assertBillingEnabled(): void {
  if (isBillingEnabled()) return
  throw createError({
    statusCode: 404,
    statusMessage: 'Not Found',
    message: 'Billing is not enabled on this deployment.',
    data: { code: BILLING_DISABLED_CODE }
  })
}

/** AI credit top-ups can be bought: billing on and `NUXT_BILLING_TOPUPS_ENABLED` not off. */
export function topupsAvailable(): boolean {
  const mode = getBillingMode()
  return mode.billingEnabled && mode.topupsEnabled !== false
}

/**
 * Guard of the top-up checkouts (personal and workspace). With billing on
 * but top-ups switched off they do not exist on this deployment: 404
 * `billing/topups-disabled`, like `billing/disabled` for billing itself.
 */
export function assertTopupsEnabled(): void {
  if (getBillingMode().topupsEnabled === false) throw apiError('billing/topups-disabled')
}

/**
 * The plan whose limits actually apply to a user.
 *
 * - Billing off → always `free`. Nobody can buy a plan, so a stale paid
 *   row (e.g. left over from a test period) must not grant paid caps.
 *   Operators raise limits for everyone via the `TIER_FREE_*` env vars.
 * - Billing on → the stored plan, unless a paid plan has lapsed
 *   (`planValidUntil` in the past), which falls back to `free`.
 */
export function effectivePlan(
  storedPlan: PlanName,
  planValidUntil: Date | null,
  now: Date = new Date()
): PlanName {
  if (!isBillingEnabled()) return 'free'
  if (storedPlan !== 'free' && planValidUntil !== null && planValidUntil.getTime() <= now.getTime()) {
    return 'free'
  }
  return storedPlan
}

/** Recovery hint shape understood by `app/composables/platform/useErrorHandler.ts`. */
export interface LimitRecovery {
  kind: 'link'
  href: string
  labelKey: string
}

/**
 * The client-side recovery affordance to attach to a "limit reached"
 * error. Billing on → "Upgrade" link to /pricing. Plans coming soon →
 * a "See upcoming plans" link (the pricing page shows the waitlist).
 * Plain self-hosted → none: there is nothing to buy, so we don't point
 * anywhere.
 */
export function limitRecovery(): LimitRecovery | undefined {
  const mode = getBillingMode()
  if (mode.billingEnabled) return { kind: 'link', href: '/pricing', labelKey: 'ai.upgradeCta' }
  if (mode.plansComingSoon) return { kind: 'link', href: '/pricing', labelKey: 'billing.comingSoonCta' }
  return undefined
}

/**
 * English sentence appended to server-side "limit reached" messages
 * (the raw message is the fallback when the client has no i18n key).
 * Never mentions a purchase that doesn't exist on this deployment.
 */
export function limitUpgradeHint(): string {
  const mode = getBillingMode()
  if (mode.billingEnabled) return 'Upgrade your plan at /pricing to get more.'
  if (mode.plansComingSoon) return 'Paid plans with higher limits are coming soon.'
  return 'Contact the operator of this instance if you need a higher limit.'
}

/**
 * Plain-English "AI Points exhausted" sentence for server-side surfaces
 * (tool results, error fallbacks). Points at /pricing only when there
 * is something to buy.
 */
export function budgetExhaustedMessage(): string {
  const mode = getBillingMode()
  if (mode.billingEnabled) return 'AI Points exhausted. Upgrade your plan at /pricing to continue.'
  const base = 'AI Points exhausted for this period. They refill when the next period starts.'
  return mode.plansComingSoon ? `${base} Paid plans with more AI Points are coming soon.` : base
}

/**
 * Markdown variant written into the document as the AI's breadcrumb.
 * Billing on → links the upgrade page; otherwise plain text.
 */
export function budgetExhaustedBreadcrumb(plan: string): string {
  const mode = getBillingMode()
  if (mode.billingEnabled) {
    return `\n\n_AI Points exhausted for this billing period (plan: ${plan}). [Upgrade your plan](/pricing) to continue._\n`
  }
  const suffix = mode.plansComingSoon ? ' Paid plans with more AI Points are [coming soon](/pricing).' : ''
  return `\n\n_AI Points exhausted for this period. They refill when the next period starts.${suffix}_\n`
}

/** i18n key the client renders for a budget-exhausted error. */
export function budgetExhaustedMessageKey(): string {
  const mode = getBillingMode()
  if (mode.billingEnabled) return 'ai.budgetExhaustedDescription'
  return mode.plansComingSoon ? 'ai.budgetExhaustedComingSoonDescription' : 'ai.budgetExhaustedResetDescription'
}
