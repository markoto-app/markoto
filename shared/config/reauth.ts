// Fresh-sign-in rule for the most damaging account actions (account deletion,
// data export, bring-your-own-key changes). The server enforces it
// (server/utils/auth/sessionPolicy.ts); the client recognises the refusal and
// offers "Sign in again".
import { HOUR_MS } from './units'

/** How old a sign-in may be for a sensitive action. */
export const RECENT_LOGIN_MAX_AGE_MS = 12 * HOUR_MS

/** Machine code of the 401 a sensitive action answers with a stale sign-in. */
export const REAUTH_REQUIRED_CODE = 'auth/reauth-required'
