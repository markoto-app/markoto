import { HOUR_SECONDS } from '~~/shared/config/units'

// Lifetime of a doc JWT (editor token, password unlock): 2 h, but never
// past the share link's expiry — a visitor's token must not outlive
// the link. Once the expiry has passed only the owner and workspace
// members still get a token, and they get the full 2 h.

export const DOC_JWT_MAX_SECONDS = 2 * HOUR_SECONDS

export function docJwtLifetimeSeconds(shareExpiresAt: Date | string | null | undefined, now: Date = new Date()): number {
  if (shareExpiresAt === null || shareExpiresAt === undefined) return DOC_JWT_MAX_SECONDS
  const t = typeof shareExpiresAt === 'string' ? Date.parse(shareExpiresAt) : shareExpiresAt.getTime()
  if (!Number.isFinite(t)) return DOC_JWT_MAX_SECONDS
  const leftMs = t - now.getTime()
  if (leftMs <= 0) return DOC_JWT_MAX_SECONDS
  return Math.max(1, Math.min(DOC_JWT_MAX_SECONDS, Math.floor(leftMs / 1000)))
}
