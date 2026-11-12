import { createHash, timingSafeEqual } from 'node:crypto'

// Shared-secret checks for the service-to-service HTTP calls inside the
// stack (app ↔ sync-server, app → renderer). One implementation for every
// side of the boundary so the comparison stays timing-safe and accepts the
// `_PREVIOUS` value during a rotation everywhere (docs/operations/SECRETS-ROTATION.md).
//
// Dependency-free on purpose (node:crypto only).

/** Header that carries `INTERNAL_API_SECRET` on internal calls. */
export const INTERNAL_SECRET_HEADER = 'x-internal-secret'

export type InternalSecretCheck = 'ok' | 'unconfigured' | 'invalid'

/**
 * Timing-safe equality of a caller-supplied secret against the current
 * and (optional) previous value. Both sides are hashed first, so neither
 * the length nor the content of the expected secret influences timing,
 * and both candidates are always compared. An empty secret never matches.
 */
export function matchesCurrentOrPrevious(
  provided: string,
  current: string,
  previous?: string | null
): boolean {
  if (!provided || !current) return false
  const matchesCurrent = digestEqual(provided, current)
  const matchesPrevious = previous ? digestEqual(provided, previous) : false
  return matchesCurrent || matchesPrevious
}

/**
 * Verdict for an incoming internal request. `unconfigured` means this
 * service has no secret to compare against: callers answer 500 rather
 * than letting the request through.
 */
export function checkInternalSecret(
  provided: unknown,
  current: string | null | undefined,
  previous?: string | null
): InternalSecretCheck {
  if (!current) return 'unconfigured'
  if (typeof provided !== 'string' || provided.length === 0) return 'invalid'
  return matchesCurrentOrPrevious(provided, current, previous || null) ? 'ok' : 'invalid'
}

/**
 * Headers the public edge proxy (Traefik) adds to every request it
 * forwards. Internal callers reach a service directly over the Docker
 * network and never send them, so their presence on an internal path
 * means the request came in from outside — refuse it even with a valid
 * secret. `X-Forwarded-For` / `-Proto` / `-Port` are deliberately not on
 * the list: Nitro's dev-server worker proxy adds those to every request.
 */
const EDGE_PROXY_HEADERS = ['x-forwarded-server', 'x-forwarded-host', 'x-real-ip', 'forwarded'] as const

export function cameThroughEdgeProxy(getHeader: (name: string) => unknown): boolean {
  return EDGE_PROXY_HEADERS.some((name) => {
    const value = getHeader(name)
    return value !== undefined && value !== null && value !== ''
  })
}

function digestEqual(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b))
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}
