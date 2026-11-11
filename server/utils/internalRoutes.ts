import { createError, getRequestHeader, type H3Event } from 'h3'
import { cameThroughEdgeProxy, checkInternalSecret, INTERNAL_SECRET_HEADER } from '../../shared/utils/internalSecret'

// Routes that only other containers of the stack may call. The public
// Traefik routers exclude these prefixes (asserted by
// scripts/selfhost-check.sh); `server/middleware/auth.ts` enforces the same
// split in code so a new route under one of them is never public by
// accident:
//
//   internal-api      /api/internal/**          sync-server → app, X-Internal-Secret
//   traefik-provider  /api/internal/traefik/custom-domains (GET)
//                                               Traefik's HTTP provider; its own
//                                               token, checked in the handler
//   render            /_internal/render/**, /api/_internal/render-bootstrap
//                                               renderer's Chromium; render-token JWT,
//                                               checked by the page / handler
//
// Every other `/api/_internal/*` route (legal texts, docs search, …) is a
// public read and not covered here.

export type InternalRouteKind = 'internal-api' | 'traefik-provider' | 'render'

export const TRAEFIK_PROVIDER_PATH = '/api/internal/traefik/custom-domains'

/**
 * Canonical form for the prefix test: decoded, lower-cased, repeated
 * slashes collapsed. Over-matching only makes a request stricter, so any
 * spelling a router might still resolve to an internal handler counts.
 */
export function normalizeInternalPath(pathname: string): string {
  let path = pathname
  try {
    path = decodeURIComponent(pathname)
  } catch {
    // Malformed escapes: classify the raw form.
  }
  return path.toLowerCase().replace(/\/{2,}/g, '/')
}

export function classifyInternalRoute(pathname: string, method: string): InternalRouteKind | null {
  const path = normalizeInternalPath(pathname)
  if (path === TRAEFIK_PROVIDER_PATH && (method === 'GET' || method === 'HEAD')) return 'traefik-provider'
  if (path.startsWith('/api/internal/') || path === '/api/internal') return 'internal-api'
  if (path.startsWith('/_internal/render/') || path === '/api/_internal/render-bootstrap') return 'render'
  return null
}

/**
 * Refuse a request to an internal route that came in through the public
 * edge proxy. 404, not 403: from outside these routes do not exist.
 */
export function rejectIfFromEdge(event: H3Event): void {
  if (cameThroughEdgeProxy(name => getRequestHeader(event, name))) {
    throw createError({ statusCode: 404, message: 'Not found' })
  }
}

/**
 * Require a valid `X-Internal-Secret` (current or previous
 * `INTERNAL_API_SECRET`). Throws 500 when the app has no secret configured
 * and 401 on a missing or wrong one.
 */
export function requireInternalSecret(event: H3Event): void {
  const config = useRuntimeConfig()
  const verdict = checkInternalSecret(
    getRequestHeader(event, INTERNAL_SECRET_HEADER),
    config.internalApiSecret,
    config.internalApiSecretPrevious || null
  )
  if (verdict === 'unconfigured') {
    throw createError({ statusCode: 500, message: 'Internal API secret not configured' })
  }
  if (verdict === 'invalid') {
    throw createError({ statusCode: 401, message: 'Invalid internal secret' })
  }
}
