import type { H3Event } from 'h3'
import { findUserById } from '../../repos/users'
import type { OnboardingState } from '../privacy/onboardingGate'
import { REAUTH_REQUIRED_CODE, REAUTH_REQUIRED_MESSAGE_KEY } from '~~/shared/config/reauth'
import { isRecentLogin, sessionEpochMatches } from './sessionPolicy'

/**
 * Bump this constant whenever the session shape changes (new required fields,
 * type changes on existing fields, etc.). Sessions whose stored `v` doesn't
 * match are treated as stale and cleared — the user is forced to log in again,
 * but they never crash on missing fields. We deliberately do NOT preserve
 * backwards compatibility; rotating sessions on shape change is the simpler
 * and safer contract while we're early.
 */
export const SESSION_VERSION = 1

/**
 * Session helpers that validate `session.user.id` still references an existing
 * row in the `users` table. Sealed cookies from `nuxt-auth-utils` survive DB
 * resets / user deletions, so `requireUserSession` alone can hand back a
 * session that references a nonexistent user — which then blows up on FK
 * inserts, returns empty query results, or silently mis-attributes activity.
 *
 * These helpers:
 *   - Validate the user id once per request (cached on `event.context`).
 *   - Clear the cookie when the user is gone OR the session shape is stale,
 *     so subsequent requests don't keep carrying the stale pointer.
 *
 * Use these everywhere a route reads `session.user.id`. Always prefer the
 * `require*` variant for endpoints that mutate state on behalf of a user.
 */

type ValidatedUser = { id: number, name: string }
type SessionCache = {
  // `undefined` = not yet checked in this request
  // `null` = checked, no valid session
  // object = checked, valid session
  validatedUser: ValidatedUser | null | undefined
  // Onboarding / policy-acceptance columns of the same row, read in the
  // same query — consumed by the onboarding gate middleware.
  onboarding?: OnboardingState
  // `loggedInAt` of the validated cookie (epoch ms), for the
  // recent-sign-in check on sensitive actions.
  loggedInAt?: unknown
}

function getCache(event: H3Event): SessionCache {
  const ctx = event.context as { _sessionCache?: SessionCache }
  ctx._sessionCache ??= { validatedUser: undefined }
  return ctx._sessionCache
}

async function resolveValidatedUser(event: H3Event): Promise<ValidatedUser | null> {
  const cache = getCache(event)
  if (cache.validatedUser !== undefined) return cache.validatedUser

  const session = await getUserSession(event)
  const sessionUserId = (session?.user as { id?: number } | undefined)?.id
  if (typeof sessionUserId !== 'number') {
    cache.validatedUser = null
    return null
  }

  // Stale session shape — clear cookie and treat as anonymous. The user can
  // re-authenticate to get a fresh session at the current SESSION_VERSION.
  if ((session as { v?: number }).v !== SESSION_VERSION) {
    await clearUserSession(event)
    cache.validatedUser = null
    return null
  }

  const row = await findUserById(sessionUserId)
  if (!row) {
    // Session references a user that no longer exists. Clear the cookie
    // so future requests are either cleanly anonymous or cleanly
    // logged-in again.
    await clearUserSession(event)
    cache.validatedUser = null
    return null
  }

  // Revoked session: the user's epoch was bumped ("log out everywhere",
  // account-deletion request) after this cookie was sealed.
  if (!sessionEpochMatches((session as { e?: unknown }).e, row.sessionEpoch)) {
    await clearUserSession(event)
    cache.validatedUser = null
    return null
  }

  const user = { id: row.id, name: row.name }
  cache.validatedUser = user
  cache.loggedInAt = (session as { loggedInAt?: unknown }).loggedInAt
  cache.onboarding = {
    ageConfirmedAt: row.ageConfirmedAt,
    privacyVersionAccepted: row.privacyVersionAccepted,
    tosVersionAccepted: row.tosVersionAccepted
  }
  return user
}

/**
 * Returns the validated session, or null if the caller is anonymous / the
 * referenced user has been deleted. Never throws. Clears a stale cookie as
 * a side-effect.
 *
 * The returned shape mirrors what `getUserSession` would give for `user`, but
 * only `id` and `name` are guaranteed to be fresh from the DB.
 */
export async function getValidatedUserSession(event: H3Event): Promise<{ user: ValidatedUser } | null> {
  const user = await resolveValidatedUser(event)
  return user ? { user } : null
}

/**
 * Like `requireUserSession`, but also proves the user row still exists. Throws
 * 401 otherwise (after clearing the stale cookie, if one was present).
 */
export async function requireValidatedUserSession(event: H3Event): Promise<{ user: ValidatedUser }> {
  const user = await resolveValidatedUser(event)
  if (!user) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }
  return { user }
}

/**
 * Onboarding / policy-acceptance state of the validated user, or null for
 * anonymous callers. Shares the per-request user lookup with the helpers
 * above (no extra query).
 */
export async function getValidatedOnboardingState(event: H3Event): Promise<OnboardingState | null> {
  const user = await resolveValidatedUser(event)
  if (!user) return null
  return getCache(event).onboarding ?? null
}

/**
 * `requireValidatedUserSession` plus a recent sign-in (see
 * `sessionPolicy.ts`). Guards the actions a stolen cookie must not be
 * able to take quietly: account deletion, data-export requests and
 * bring-your-own-key provider changes. A stale sign-in answers 401
 * `auth/reauth-required`; the client offers "Sign in again".
 */
export async function requireRecentLogin(event: H3Event): Promise<{ user: ValidatedUser }> {
  const session = await requireValidatedUserSession(event)
  if (!isRecentLogin(getCache(event).loggedInAt)) {
    throw createError({
      statusCode: 401,
      message: 'Please sign in again to continue.',
      data: { code: REAUTH_REQUIRED_CODE, messageKey: REAUTH_REQUIRED_MESSAGE_KEY }
    })
  }
  return session
}
