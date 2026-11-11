// Server-side accessors for the instance shape (login providers + legal
// surfaces). See `shared/config/instance.ts` for the deployment matrix.
//
// Reads `process.env` on every call so tests can flip flags per case and the
// helpers work outside Nitro.

import { createError } from 'h3'
import { resolveLegalSurfacesEnabled } from '~~/shared/config/instance'
import { resolveLegalEntity } from '~~/shared/legal/entity'

export function legalSurfacesEnabled(): boolean {
  return resolveLegalSurfacesEnabled(process.env)
}

/** Stable machine code for "this deployment has no legal pages". */
export const LEGAL_DISABLED_CODE = 'legal/disabled'

/**
 * Guard for the legal-document endpoints. With the legal surfaces off, the
 * bundled texts must not be served from a self-hosted origin: they name
 * LatentSpace Labs as the operator. 404, as for a route that doesn't exist.
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
