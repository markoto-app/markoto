import { MINUTE_MS } from './units'
import type { RateLimitRule } from './anonLimits'

// GET /api/docs/:id/token: every editor tab asks on load, on renewal and
// after a reconnect; a hidden tab coming back counts too. A load test with
// 500 reader tabs behind one address asked about 54 per minute, so an
// office behind one NAT address went over the former 30 per address.
//
// Two limits (counters in Valkey, server/utils/platform/rateLimit.ts,
// fail open):
//   - per client address (IPv4 or IPv6 /64), counted before the session and
//     the document lookup, so probing for document ids (404) is throttled.
//     It is the ceiling for everyone behind one address: about 2000 tabs.
//     Document ids carry 60 random bits, so the probing it allows finds
//     nothing;
//   - per caller once the document is found: a signed-in user's own budget
//     (several tabs, reloads), so one busy account can't use up its
//     colleagues' share of the address; anonymous callers share one per
//     address.

/** Every request from one client address, before anything is looked up. */
export const DOC_TOKEN_ADDRESS_LIMIT: RateLimitRule = Object.freeze({
  namespace: 'token', max: 240, windowMs: MINUTE_MS
})

/** Per signed-in user, or per client address for anonymous callers. */
export const DOC_TOKEN_CALLER_LIMIT: RateLimitRule = Object.freeze({
  namespace: 'token-caller', max: 60, windowMs: MINUTE_MS
})
