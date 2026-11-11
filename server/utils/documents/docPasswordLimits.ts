import { checkRateLimit, isRateLimitExhausted, recordRateLimitEvent } from '../platform/rateLimit'
import { HOUR_MS } from '~~/shared/config/units'

// Brute-force limits for `POST /api/docs/:id/password` (action=verify).
// Three layers, all Valkey-backed and atomic (see rateLimit.ts):
//
//   1. per client + doc   — 5 attempts / min. Client = IPv4 address or
//                           IPv6 /64 (`getClientRateLimitKey`).
//   2. per doc, global    — 30 attempts / min across ALL clients, so a
//                           botnet / address pool can't multiply layer 1.
//   3. per doc failures   — 30 FAILED attempts / hour lock the doc's
//                           password check until failures age out.
//                           Workspace members and the owner never need
//                           the password, and the owner can rotate it.
//
// Like every request limiter these fail OPEN on Valkey errors.

export const DOC_PASSWORD_LIMITS = {
  perClient: { max: 5, windowMs: 60_000 },
  perDoc: { max: 30, windowMs: 60_000 },
  failures: { max: 30, windowMs: HOUR_MS }
} as const

export type PasswordAttemptOutcome = 'allowed' | 'rate-limited' | 'locked'

/** Decide whether a verify attempt may run. Consumes one attempt from layers 1 + 2 when admitted. */
export async function admitPasswordAttempt(clientKey: string, docId: string): Promise<PasswordAttemptOutcome> {
  const { perClient, perDoc, failures } = DOC_PASSWORD_LIMITS
  if (await isRateLimitExhausted('password-fail-doc', docId, failures.max, failures.windowMs)) {
    return 'locked'
  }
  if (!(await checkRateLimit('password-verify', `${clientKey}:${docId}`, perClient.max, perClient.windowMs))) {
    return 'rate-limited'
  }
  if (!(await checkRateLimit('password-verify-doc', docId, perDoc.max, perDoc.windowMs))) {
    return 'rate-limited'
  }
  return 'allowed'
}

/** Count one failed verification against the doc's failure budget (layer 3). */
export async function recordPasswordFailure(docId: string): Promise<void> {
  await recordRateLimitEvent('password-fail-doc', docId, DOC_PASSWORD_LIMITS.failures.windowMs)
}
