// Billing mode — which commercial surface this deployment runs.
//
// markoto ships ONE codebase for three deployment shapes; configuration
// alone picks between them:
//
//   | Shape                      | NUXT_BILLING_ENABLED | NUXT_PLANS_COMING_SOON |
//   |----------------------------|----------------------|------------------------|
//   | Self-hosted (default)      | false                | false                  |
//   | Hosted SaaS, free-only     | false                | true                   |
//   | Hosted SaaS, paid plans on | true                 | (ignored)              |
//
// Billing OFF means: no Stripe calls anywhere, Stripe env vars not
// required at boot, `/api/billing/{checkout,portal}` + the Stripe webhook
// + workspace AI sponsorship answer 404 `billing/disabled`, Stripe
// sweepers don't run, and every user resolves to the FREE tier for
// limits (raise the free tier via `TIER_FREE_*` env vars — see
// `shared/config/tiers.ts#resolveTiersFromEnv`).
//
// `plansComingSoon` is only meaningful while billing is OFF: it turns
// on the hosted-SaaS "paid plans are coming soon" surfaces (pricing
// page tiers + waitlist, limit messages that mention upcoming plans).
// A self-hoster leaves it off so their users are never pointed at
// LatentSpace Labs' commercial offering.
//
// Pure — takes an env-shaped record so every test tier can drive it
// without a Nitro context (same pattern as `resolveTiersFromEnv`).

export interface BillingMode {
  /** Stripe checkout / portal / webhooks / paid tiers are live. */
  billingEnabled: boolean
  /**
   * Billing is off AND this deployment advertises upcoming paid plans
   * (pricing page "coming soon" + waitlist). Always false when
   * `billingEnabled` is true.
   */
  plansComingSoon: boolean
}

export const BILLING_DISABLED_MODE: BillingMode = Object.freeze({
  billingEnabled: false,
  plansComingSoon: false
})

const TRUTHY = new Set(['1', 'true', 'yes', 'on'])

/**
 * Parse a boolean env flag. Accepts `1` / `true` / `yes` / `on`
 * (case-insensitive, whitespace-tolerant); anything else — including
 * absent — is false. A typo therefore fails CLOSED to "billing off",
 * which is the safe direction: nobody gets charged by accident.
 */
export function parseBooleanFlag(raw: string | undefined): boolean {
  if (raw === undefined) return false
  return TRUTHY.has(raw.trim().toLowerCase())
}

export function resolveBillingMode(env: Record<string, string | undefined>): BillingMode {
  const billingEnabled = parseBooleanFlag(env.NUXT_BILLING_ENABLED)
  return {
    billingEnabled,
    plansComingSoon: !billingEnabled && parseBooleanFlag(env.NUXT_PLANS_COMING_SOON)
  }
}
