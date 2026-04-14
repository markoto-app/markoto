import { timingSafeEqual } from 'node:crypto'
import jwt from 'jsonwebtoken'

// Mirror of the app-side rotation helpers (server/utils/secrets.ts) — kept
// standalone because sync-server doesn't share the Nuxt runtime. Keep both
// copies in sync when editing either.

export function matchesCurrentOrPrevious(
  provided: string,
  current: string,
  previous?: string | null
): boolean {
  if (safeEqual(provided, current)) return true
  if (previous && safeEqual(provided, previous)) return true
  return false
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  return timingSafeEqual(Buffer.from(a), Buffer.from(b))
}

export function verifyJwtWithRotation<T = Record<string, unknown>>(
  token: string,
  current: string,
  previous?: string | null
): T {
  try {
    return jwt.verify(token, current) as T
  } catch (err) {
    if (previous && err instanceof jwt.JsonWebTokenError && !(err instanceof jwt.TokenExpiredError)) {
      return jwt.verify(token, previous) as T
    }
    throw err
  }
}
