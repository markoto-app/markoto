import { createHash } from 'node:crypto'
import type { H3Event } from 'h3'
import {
  recordAdConversion,
  recordFirstDocumentFromSignupClick,
  recordWaitlistAdConversion,
  type AdConversionKind
} from '../../repos/adConversions'
import { system, type UserScope } from '../../repos/proofs'
import { useValkey } from '../platform/valkey'
import { useLogger } from '../platform/logger'
import { clickIdFromQuery, type ClickId } from '~~/shared/analytics/attribution'
import { optedOutByHeaders } from '~~/shared/analytics/pages'
import { useEnv } from '~~/shared/env/load'

const log = useLogger('ad-conversions')

// Google Ads click-id conversions (docs/operations-analytics.md). The click
// id reaches the server only inside a request that is itself the
// conversion: the body of POST /api/docs and POST /api/waitlist, or the
// query of the sign-in link (/auth/google?gclid=…), from where it waits in
// Valkey for the OAuth callback, keyed by the OAuth `state`. Nothing is
// stored in the browser for it. Off unless
// NUXT_PUBLIC_ANALYTICS_ADS_CONVERSIONS; a request with Global Privacy
// Control or Do Not Track is never recorded. A failure to record is logged
// and never fails the user's request.

/** How long a click waits for the OAuth callback. */
const OAUTH_CLICK_TTL_SECONDS = 15 * 60

function adConversionsEnabled(): boolean {
  return useEnv().analytics.adsConversions
}

function accepted(event: H3Event, clickId: ClickId | null | undefined): clickId is ClickId {
  if (!clickId || !adConversionsEnabled()) return false
  return !optedOutByHeaders(name => getRequestHeader(event, name))
}

async function guarded(what: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn()
  } catch (err) {
    log.warn('could not record a conversion', { what, reason: err instanceof Error ? err.message : String(err) })
  }
}

/** A sign-up, document creation or other conversion carrying its own click id. */
async function captureAdConversion(event: H3Event, clickId: ClickId | null | undefined, conversion: AdConversionKind, userId?: number | null): Promise<void> {
  if (!accepted(event, clickId)) return
  await guarded(conversion, () => recordAdConversion(system('ad-conversions'), { clickId, conversion, userId }))
}

/** A waitlist sign-up (`email` normalised; the row was just written). */
export async function captureWaitlistConversion(event: H3Event, clickId: ClickId | null | undefined, email: string): Promise<void> {
  if (!accepted(event, clickId)) return
  await guarded('waitlist_signup', () => recordWaitlistAdConversion(system('ad-conversions'), clickId, email))
}

/**
 * A new document. Anonymous or signed in with the click in the body: that
 * click converts. Signed in without one: the account's sign-up click, if
 * it came from an ad, converts (once).
 */
export async function captureDocumentConversion(event: H3Event, clickId: ClickId | null | undefined, self: UserScope | null): Promise<void> {
  if (!adConversionsEnabled() || optedOutByHeaders(name => getRequestHeader(event, name))) return
  if (clickId) {
    await captureAdConversion(event, clickId, 'first_document', self?.userId ?? null)
    return
  }
  if (self) await guarded('first_document', () => recordFirstDocumentFromSignupClick(self))
}

function oauthKey(state: string): string {
  return `ads:oauth-click:${createHash('sha256').update(state).digest('hex')}`
}

/**
 * Start leg of a sign-in (`/auth/<provider>` without `code`), after the
 * OAuth handler set its redirect: park the link's click id under the OAuth
 * `state` of that redirect.
 */
export async function rememberOAuthClick(event: H3Event): Promise<void> {
  const clickId = clickIdFromQuery(getQuery(event))
  if (!accepted(event, clickId)) return
  const location = event.node.res.getHeader('location')
  if (typeof location !== 'string') return
  let state: string | null = null
  try {
    state = new URL(location).searchParams.get('state')
  } catch {
    return
  }
  if (!state) return
  await guarded('oauth-start', () => useValkey().set(oauthKey(state), JSON.stringify(clickId), 'EX', OAUTH_CLICK_TTL_SECONDS))
}

/** Callback leg of a sign-in that created an account: its parked click id becomes a `signup` conversion. */
export async function captureOAuthSignup(event: H3Event, userId: number): Promise<void> {
  if (!adConversionsEnabled()) return
  const state = getQuery(event).state
  if (typeof state !== 'string' || !state) return
  await guarded('signup', async () => {
    const raw = await useValkey().getdel(oauthKey(state))
    if (!raw) return
    const parked = JSON.parse(raw) as Partial<ClickId>
    const clickId = parked.type ? clickIdFromQuery({ [parked.type]: parked.value }) : null
    if (clickId) await recordAdConversion(system('ad-conversions'), { clickId, conversion: 'signup', userId })
  })
}
