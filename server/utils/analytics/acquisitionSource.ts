import { createHash } from 'node:crypto'
import type { H3Event } from 'h3'
import { getAccountAcquisitionSource, recordAccountAcquisitionSource, recordCheckoutStarted } from '../../repos/acquisition'
import { system, type UserScope } from '../../repos/proofs'
import { useValkey } from '../platform/valkey'
import { useLogger } from '../platform/logger'
import { oauthRedirectState } from '../auth/loginReturn'
import { SIGNED_UP_SOURCE_PARAM, SOURCE_PARAM, parseAcquisitionSource, type AcquisitionSource } from '~~/shared/analytics/acquisition'
import { appendQueryParam } from '~~/shared/utils/security/loginReturn'
import { optedOutByHeaders } from '~~/shared/analytics/pages'
import { useEnv } from '~~/shared/env/load'

const log = useLogger('acquisition')

// Acquisition source of the admin's "Funnel by source"
// (shared/analytics/acquisition.ts, docs/contributing/admin-metrics.md).
// The browser sends the visit's source, one category of a fixed list,
// only with the requests that are funnel steps: POST /api/docs, and the
// sign-in link (`/auth/google?ref=producthunt`), from where it waits in
// Valkey for the OAuth callback, keyed by the OAuth `state`. Stored only
// where the statistics are on (NUXT_PUBLIC_ANALYTICS_WEBSITE_ID) and never
// for a request with Global Privacy Control or Do Not Track. A failure to
// record is logged and never fails the user's request.

/** How long a source waits for the OAuth callback. */
const OAUTH_SOURCE_TTL_SECONDS = 15 * 60

export function acquisitionTrackingEnabled(): boolean {
  return Boolean(useEnv().analytics.websiteId)
}

function accepted(event: H3Event): boolean {
  return acquisitionTrackingEnabled() && !optedOutByHeaders(name => getRequestHeader(event, name))
}

function warn(what: string, err: unknown): void {
  log.warn('could not record an acquisition step', { what, reason: err instanceof Error ? err.message : String(err) })
}

/**
 * The source to store on a new document: the account's for a signed-in
 * creator (a referrer seen after a sign-in is the provider's page, not a
 * source), else the one the anonymous visit sent.
 */
export async function documentAcquisitionSource(event: H3Event, sent: unknown, self: UserScope | null): Promise<AcquisitionSource | null> {
  if (!accepted(event)) return null
  if (!self) return parseAcquisitionSource(sent)
  try {
    return await getAccountAcquisitionSource(self)
  } catch (err) {
    warn('document', err)
    return null
  }
}

function oauthKey(state: string): string {
  return `acq:oauth-source:${createHash('sha256').update(state).digest('hex')}`
}

/** Start leg of a sign-in: park the link's `ref` under the OAuth `state` of the redirect. */
export async function rememberOAuthSource(event: H3Event): Promise<void> {
  const source = parseAcquisitionSource(getQuery(event)[SOURCE_PARAM])
  if (!source || !accepted(event)) return
  const state = oauthRedirectState(event)
  if (!state) return
  try {
    await useValkey().set(oauthKey(state), source, 'EX', OAUTH_SOURCE_TTL_SECONDS)
  } catch (err) {
    warn('oauth-start', err)
  }
}

/**
 * Callback leg of a sign-in that created an account: the parked source
 * becomes the account's. Returns it, so the landing page can tag the
 * sign-up event with it; null when none.
 */
export async function captureSignupSource(event: H3Event, userId: number): Promise<AcquisitionSource | null> {
  if (!acquisitionTrackingEnabled()) return null
  const state = getQuery(event).state
  if (typeof state !== 'string' || !state) return null
  try {
    const source = parseAcquisitionSource(await useValkey().getdel(oauthKey(state)))
    if (!source) return null
    await recordAccountAcquisitionSource(system('acquisition-source').actingFor(userId), source)
    return source
  } catch (err) {
    warn('signup', err)
    return null
  }
}

/** The landing path of a new account, with its source for the client's sign-up event. */
export function withSignupSource(path: string, source: AcquisitionSource | null): string {
  return source ? appendQueryParam(path, SIGNED_UP_SOURCE_PARAM, source) : path
}

/** A paid checkout was opened (the funnel's "started a checkout" step; first one only). */
export async function captureCheckoutStarted(event: H3Event, self: UserScope): Promise<void> {
  if (!accepted(event)) return
  try {
    await recordCheckoutStarted(self)
  } catch (err) {
    warn('checkout', err)
  }
}
