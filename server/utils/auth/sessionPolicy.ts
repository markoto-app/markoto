// Pure session rules (no H3 / Nitro imports, so unit tests can pin them).
// The request-bound halves live in `validatedSession.ts`.
//
// Two mechanisms make the cookie-only session revocable and keep the
// most damaging actions behind a fresh sign-in:
//
//   1. Session epoch. `users.session_epoch` is copied into the sealed
//      cookie (`e`) at sign-in. A cookie whose `e` differs from the
//      column is rejected on the next request. Bumping the column
//      ("log out everywhere", account-deletion request) therefore kills
//      every cookie issued before the bump, including a stolen copy.
//      A cookie without `e` counts as epoch 0, the column default.
//   2. Recent sign-in. Account deletion, data-export requests and
//      bring-your-own-key provider changes need `loggedInAt` within
//      `RECENT_LOGIN_MAX_AGE_MS`; otherwise the API answers 401
//      `auth/reauth-required` and the client offers "Sign in again".

/** How old a sign-in may be for a sensitive action. */
export const RECENT_LOGIN_MAX_AGE_MS = 12 * 60 * 60 * 1000

/** Machine code of the 401 a sensitive action answers with a stale sign-in. */
export const REAUTH_REQUIRED_CODE = 'auth/reauth-required'

/** i18n key the client shows for `REAUTH_REQUIRED_CODE`. */
export const REAUTH_REQUIRED_MESSAGE_KEY = 'auth.reauthRequired'

/** The epoch a sealed session carries; absent / malformed → 0. */
export function sessionEpochOf(sessionEpoch: unknown): number {
  return typeof sessionEpoch === 'number' && Number.isInteger(sessionEpoch) ? sessionEpoch : 0
}

/** True when the cookie's epoch is the user's current one. */
export function sessionEpochMatches(sessionEpoch: unknown, userEpoch: number): boolean {
  return sessionEpochOf(sessionEpoch) === userEpoch
}

/**
 * True when `loggedInAt` (epoch ms, as written by the OAuth handlers)
 * is no older than `maxAgeMs`. A missing / malformed / future value is
 * NOT recent — fail closed, the user just signs in again.
 */
export function isRecentLogin(
  loggedInAt: unknown,
  now: number = Date.now(),
  maxAgeMs: number = RECENT_LOGIN_MAX_AGE_MS
): boolean {
  if (typeof loggedInAt !== 'number' || !Number.isFinite(loggedInAt)) return false
  const age = now - loggedInAt
  // Small tolerance for clock skew between app instances.
  if (age < -60_000) return false
  return age <= maxAgeMs
}
