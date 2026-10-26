// Server-side accessors for the instance shape (login providers + legal
// surfaces). See `shared/config/instance.ts` for the deployment matrix.
//
// Reads `process.env` on every call (same reasoning as `billingMode.ts`):
// tests flip the flags per case, and helpers work outside Nitro.

import { createError } from 'h3'
import { resolveInstanceConfig, resolveLegalSurfacesEnabled, type InstanceConfig } from '~~/shared/config/instance'
import { resolveLegalEntity } from '~~/shared/legal/entity'

export function getInstanceConfig(): InstanceConfig {
  return resolveInstanceConfig(process.env)
}

export function legalSurfacesEnabled(): boolean {
  return resolveLegalSurfacesEnabled(process.env)
}

/** Stable machine code for "this deployment has no legal pages". */
export const LEGAL_DISABLED_CODE = 'legal/disabled'

/**
 * Guard for the legal-document endpoints. With the legal surfaces off the
 * hosted service's texts must not be served under a self-hosted origin —
 * they would name LatentSpace Labs as the operator. 404, like a route
 * that doesn't exist (same reasoning as `assertBillingEnabled`).
 */
export function assertLegalSurfacesEnabled(): void {
  if (legalSurfacesEnabled()) return
  throw createError({
    statusCode: 404,
    statusMessage: 'Not Found',
    message: 'Legal pages are not enabled on this deployment.',
    data: { code: LEGAL_DISABLED_CODE }
  })
}

/**
 * Where abuse-report notifications go. An explicitly configured
 * `NUXT_LEGAL_ABUSE_CONTACT_EMAIL` always wins. Otherwise the legal
 * entity's default inbox — but only while the legal surfaces are on (the
 * hosted SaaS): a self-hosted instance must never mail its users' reports
 * to the hosted operator. `null` = no email; the report still lands in
 * the admin queue (/admin/abuse-reports).
 */
export function abuseNotificationRecipient(): string | null {
  const explicit = process.env.NUXT_LEGAL_ABUSE_CONTACT_EMAIL?.trim()
  if (explicit) return explicit
  return legalSurfacesEnabled() ? resolveLegalEntity(process.env).abuseContactEmail : null
}
