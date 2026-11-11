import { requestAccountDeletionByUser } from '../../utils/privacy/accountDeletion'
import { bumpSessionEpoch } from '../../repos/users'
import { checkRateLimit } from '../../utils/platform/rateLimit'
import { isRepoError } from '../../repos/errors'
import { HOUR_MS } from '~~/shared/config/units'

// GDPR Article 17 — request account deletion. Marks the user with a
// 30-day grace period; the cascading purge is performed asynchronously
// by `accountDeletionSweep` once `deletion_grace_until` elapses. The
// user's account remains usable during the grace period and a UI
// banner offers a one-click cancel.
//
// Rate limit: 5 requests per user per hour. Higher than a brute-force
// limit (so a real user fumbling buttons isn't blocked) but tight
// enough that a stolen session can't issue thousands of requests.
//
// Idempotency: NOT idempotent at the repo layer. A second request
// while one is already scheduled returns 409 (the orchestrator throws
// a `ConflictError`). This is deliberate — we don't reset the grace
// clock on re-request, because doing so would let an attacker with a
// session token keep extending the deletion window indefinitely.
//
// Audit: an `account.delete_requested` audit row is appended after
// the user-row update commits. Email is best-effort.

export default defineApiHandler({
  access: allow.user(),
  // Sensitive action: needs a recent sign-in (401 auth/reauth-required).
  recentLogin: true,
  body: 'none',
  handler: async ({ event, user }) => {
    const userId = user.id

    const ip = getClientIp(event)

    // Rate limit on (userId, IP) — userId-only would be DoS-able by a
    // session-stealing attacker; IP-only would be unfair to mobile users
    // behind shared NAT. Hash both so the key isn't a PII column. Inline:
    // the wrapper's per-user key has no client address.
    const rlKey = `${userId}:${getClientRateLimitKey(event)}`
    if (!(await checkRateLimit('account-delete-request', rlKey, 5, HOUR_MS))) {
      throw apiError('account/delete-rate-limited')
    }

    try {
      const result = await requestAccountDeletionByUser({
        userId,
        actorIp: ip
      })

      // Sign out every OTHER session: a deletion request is exactly when a
      // stolen cookie must stop working. This browser keeps its session
      // (re-sealed with the new epoch) so the user can still cancel from
      // the grace banner.
      const epoch = await bumpSessionEpoch(userId)
      if (epoch !== null) await setUserSession(event, { e: epoch })

      return {
        ok: true,
        deletionRequestedAt: result.status.deletionRequestedAt?.toISOString() ?? null,
        deletionGraceUntil: result.status.deletionGraceUntil?.toISOString() ?? null,
        emailAttempted: result.emailAttempted
      }
    } catch (e) {
      if (isRepoError(e)) {
        throw apiError('account/delete-conflict', undefined, { status: e.httpStatus as 409 | 404, cause: e })
      }
      throw e
    }
  }
})
