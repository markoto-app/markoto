// Workspace AI sponsorship (`(+)`, `workspaces.ai_enabled` +
// `billing_owner_id`): which plans may sponsor, and how the workspace
// page presents the option in each billing mode. Pure — shared by the
// server's enforcement (`server/utils/billing.ts`) and the UI.

import type { BillingMode } from './billingMode'
import type { PlanName } from './tiers'

/** Only Max and Ultra can sponsor a workspace. Pro is personal-only. */
export function planSupportsTeamBilling(plan: PlanName): boolean {
  return plan === 'max' || plan === 'ultra'
}

/**
 * How the sponsorship option shows on the workspace page:
 * - `hidden`: self-hosted (billing off, no coming-soon) — there is no
 *   upgrade path, so the option doesn't exist.
 * - `comingSoon`: hosted free-only SaaS — shown disabled with a "coming
 *   with paid plans" note linking /pricing.
 * - `loading`: billing on, the caller's plan isn't known yet — disabled.
 * - `needsUpgrade`: billing on, the plan can't sponsor — shown disabled
 *   with an upgrade note linking /pricing.
 * - `available`: billing on and the plan can sponsor.
 */
export type SponsorshipAvailability = 'hidden' | 'comingSoon' | 'loading' | 'needsUpgrade' | 'available'

export function sponsorshipAvailability(mode: BillingMode, plan: PlanName | null): SponsorshipAvailability {
  if (!mode.billingEnabled) return mode.plansComingSoon ? 'comingSoon' : 'hidden'
  if (plan === null) return 'loading'
  return planSupportsTeamBilling(plan) ? 'available' : 'needsUpgrade'
}

/**
 * Whether the workspace page shows the sponsorship (AI) tab at all.
 * Only with billing on: sponsorship is being replaced by the per-seat
 * Team plan (implementation plan WS5), so the hosted free-only phase no
 * longer advertises it as "coming with paid plans".
 */
export function sponsorshipTabVisible(mode: BillingMode): boolean {
  return mode.billingEnabled
}
