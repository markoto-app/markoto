import { PRIVACY_VERSION, TOS_VERSION } from '../../../shared/legal/versions'

// Server-side half of the onboarding gate (hosted shape, legal surfaces
// on). The UI blocks the app shell until a signed-in user has confirmed
// age >= 16 and accepted the CURRENT Privacy Policy + Terms; this check
// makes the API agree, so a client that skips the modal can't change
// state or run AI before accepting. Enforced by
// `server/middleware/onboarding.ts` on every state-changing `/api` call
// of a signed-in user; anonymous callers are never gated (they have no
// account to accept anything for) and GET/HEAD reads stay open so the
// app can render the gate itself.

export const ONBOARDING_REQUIRED_CODE = 'onboarding/required'

export interface OnboardingState {
  ageConfirmedAt: Date | null
  privacyVersionAccepted: number | null
  tosVersionAccepted: number | null
}

/** True when the user still has to confirm their age or (re-)accept Privacy / ToS. */
export function onboardingIncomplete(state: OnboardingState): boolean {
  if (state.ageConfirmedAt === null) return true
  if (state.privacyVersionAccepted === null || state.privacyVersionAccepted < PRIVACY_VERSION) return true
  return state.tosVersionAccepted === null || state.tosVersionAccepted < TOS_VERSION
}

// Routes a not-yet-onboarded user must still be able to call:
// accepting the gate itself, logging out (incl. "log out everywhere"),
// the cookie banner (layered above the gate), leaving (account deletion + its cancel), taking
// their data with them (export), withdrawing waitlist consent from an
// email link, reporting illegal content (DSA Art.16: anyone may notify,
// accepting our terms is not a precondition), and the non-session
// surfaces (webhooks, internal, test).
const EXEMPT_PATHS: RegExp[] = [
  /^\/api\/user\/onboarding-accept$/,
  /^\/api\/_auth\/session$/,
  /^\/api\/user\/sessions\/revoke$/,
  /^\/api\/consent$/,
  /^\/api\/user\/delete$/,
  /^\/api\/user\/delete-cancel$/,
  /^\/api\/user\/export$/,
  /^\/api\/waitlist\/(?:confirm|unsubscribe)$/,
  /^\/api\/abuse-reports$/,
  /^\/api\/webhooks\//,
  /^\/api\/internal\//,
  /^\/api\/_internal\//,
  /^\/api\/_test\//
]

const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/** Does the onboarding gate apply to this request at all (before looking at the user)? */
export function isOnboardingGatedRequest(method: string, path: string): boolean {
  if (!STATE_CHANGING_METHODS.has(method.toUpperCase())) return false
  if (!path.startsWith('/api/')) return false
  return !EXEMPT_PATHS.some(re => re.test(path))
}
