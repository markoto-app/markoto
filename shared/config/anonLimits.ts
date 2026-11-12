import { DAY_MS, HOUR_MS } from './units'

// Rate limits for anonymous visitors, per client key (IPv4 address or
// IPv6 /64: `getClientRateLimitKey`). Applied on top of the ALTCHA bot
// check (server/utils/anonGate/). Signed-in users are exempt from the
// doc-creation limits; their abuse reports keep the per-user limit.
// All are sliding windows in Valkey (server/utils/platform/rateLimit.ts, fail open).

export interface RateLimitRule {
  namespace: string
  max: number
  windowMs: number
}

/** POST /api/docs without a session: 10 per hour and 30 per day. */
export const ANON_DOC_CREATE_LIMITS: readonly RateLimitRule[] = Object.freeze([
  { namespace: 'anon-doc-create-hour', max: 10, windowMs: HOUR_MS },
  { namespace: 'anon-doc-create-day', max: 30, windowMs: DAY_MS }
])

/** POST /api/abuse-reports without a session: 5 per hour and 20 per day. */
export const ANON_ABUSE_REPORT_LIMITS: readonly RateLimitRule[] = Object.freeze([
  { namespace: 'abuse-report-anon-hour', max: 5, windowMs: HOUR_MS },
  { namespace: 'abuse-report-anon-day', max: 20, windowMs: DAY_MS }
])

/** POST /api/abuse-reports with a session: 10 per user per hour (unchanged). */
export const USER_ABUSE_REPORT_LIMIT: RateLimitRule = Object.freeze({
  namespace: 'abuse-report', max: 10, windowMs: HOUR_MS
})
