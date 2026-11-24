// Billing mode: which commercial surface this deployment runs.
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
// limits (raise the free tier via `TIER_FREE_*` env vars, see
// `shared/config/tiers.ts#resolveTiersFromEnv`).
//
// `plansComingSoon` is only meaningful while billing is OFF: it turns
// on the hosted-SaaS "paid plans are coming soon" surfaces (pricing
// page tiers + waitlist, limit messages that mention upcoming plans).
// A self-hoster leaves it off so their users are never pointed at
// LatentSpace Labs' commercial offering.
//
// Reads the typed env (shared/env); a test passes its own env-shaped
// record instead of process.env.

import { useEnv } from '../env/load'
import type { RawEnv } from '../env/define'

export interface BillingMode {
  /** Stripe checkout / portal / webhooks / paid tiers are live. */
  billingEnabled: boolean
  /**
   * Billing is off AND this deployment advertises upcoming paid plans
   * (pricing page "coming soon" + waitlist). Always false when
   * `billingEnabled` is true.
   */
  plansComingSoon: boolean
  /**
   * Billing is on and paid plans are sold through Stripe Managed Payments
   * (Stripe / Link is the merchant of record): purchase surfaces say so.
   * Absent = false.
   */
  managedPayments?: boolean
  /**
   * AI credit top-ups are sold (`NUXT_BILLING_TOPUPS_ENABLED`, default on).
   * Can be off while billing is on: Stripe Managed Payments sells
   * stored-value credits only after its written approval. Only meaningful
   * with billing on (or coming soon, where it decides whether the packs are
   * advertised). Absent = true.
   */
  topupsEnabled?: boolean
}

export const BILLING_DISABLED_MODE: BillingMode = Object.freeze({
  billingEnabled: false,
  plansComingSoon: false,
  managedPayments: false,
  topupsEnabled: true
})

export function resolveBillingMode(source?: RawEnv): BillingMode {
  const { billing } = useEnv(source)
  return {
    billingEnabled: billing.enabled,
    plansComingSoon: !billing.enabled && billing.plansComingSoon,
    managedPayments: billing.enabled && billing.stripeManagedPayments,
    topupsEnabled: billing.topupsEnabled
  }
}
