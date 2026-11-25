import { createHash } from 'node:crypto'
import { getQuery, type H3Event } from 'h3'
import { useValkey } from '../platform/valkey'
import { useLogger } from '../platform/logger'
import type { OAuthUpsertOutcome } from '../../repos/userSignIn'
import { LOGIN_RETURN_PARAM, appendQueryParam, safeLoginReturnPath } from '~~/shared/utils/security/loginReturn'

const log = useLogger('auth')

// The page a sign-in returns to (`/auth/<provider>?return=/pricing?interval=year`).
// The start leg parks the checked path in Valkey under the OAuth `state`
// of the redirect it sends; the callback, which carries the same `state`,
// takes it back once. Nothing is stored in the browser for it, and a path
// is only ever one of this site's own pages (`safeLoginReturnPath`).

/** How long a sign-in may take before the return path is forgotten. */
const LOGIN_RETURN_TTL_SECONDS = 15 * 60

function returnKey(state: string): string {
  return `auth:login-return:${createHash('sha256').update(state).digest('hex')}`
}

/** The OAuth `state` of the start leg's redirect to the provider (its `Location` header). */
function redirectState(event: H3Event): string | null {
  const location = event.node.res.getHeader('location')
  if (typeof location !== 'string') return null
  try {
    return new URL(location).searchParams.get('state')
  } catch {
    return null
  }
}

/**
 * Start leg of a sign-in: park the link's return path under the OAuth
 * `state` (read from the redirect the handler set, unless given). Best
 * effort: without Valkey the sign-in still works and lands on `/`.
 */
export async function rememberLoginReturn(event: H3Event, state: string | null = redirectState(event)): Promise<void> {
  const path = safeLoginReturnPath(getQuery(event)[LOGIN_RETURN_PARAM])
  if (!path || !state) return
  try {
    await useValkey().set(returnKey(state), path, 'EX', LOGIN_RETURN_TTL_SECONDS)
  } catch (err) {
    log.warn('could not park the sign-in return path', { reason: err instanceof Error ? err.message : String(err) })
  }
}

/**
 * Where a completed sign-in lands: `path` (else `/`) marked for the client.
 * `signed_in=1` makes it take over this browser's anonymous documents
 * (`app/plugins/sign-in-return.client.ts` calls `POST /api/docs/adopt`);
 * `linked=<provider>` explains a merge into an existing account,
 * `signed_up=<provider>` is the sign-up event of a new account.
 */
export function signedInLanding(path: string | null, provider: string, outcome: OAuthUpsertOutcome | 'existing'): string {
  let landing = path ?? '/'
  if (outcome === 'merged') landing = appendQueryParam(landing, 'linked', provider)
  if (outcome === 'inserted') landing = appendQueryParam(landing, 'signed_up', provider)
  return appendQueryParam(landing, 'signed_in', '1')
}

/**
 * Callback leg: where the signed-in browser goes: the parked return path,
 * if any, else `/`, with the markers of `signedInLanding`.
 */
export async function loginLandingPath(event: H3Event, provider: string, outcome: OAuthUpsertOutcome): Promise<string> {
  const state = getQuery(event).state
  let parked: string | null = null
  if (typeof state === 'string' && state) {
    try {
      parked = safeLoginReturnPath(await useValkey().getdel(returnKey(state)))
    } catch (err) {
      log.warn('could not read the sign-in return path', { reason: err instanceof Error ? err.message : String(err) })
    }
  }
  return signedInLanding(parked, provider, outcome)
}
