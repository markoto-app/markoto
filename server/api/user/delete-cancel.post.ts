import { cancelAccountDeletionByUser } from '../../utils/privacy/accountDeletion'
import { isRepoError } from '../../repos/errors'
import { HOUR_MS } from '~~/shared/config/units'

// GDPR Article 17 — cancel an in-flight account deletion request.
// Available throughout the 30-day grace window. Once the sweeper has
// executed (i.e. `users` row is gone), this endpoint cannot reach
// you — the session has been invalidated and login fails.
//
// Rate limit: shares the same per-user budget as request, so an
// attacker who fires requests + cancels alternately can't pump the
// audit log. 5/hr each, both share the same key namespace.
//
// 409 on cancel-when-not-scheduled (`ConflictError` from the
// orchestrator). The UI should suppress the cancel button when no
// deletion is scheduled, but the server enforces.

export default defineApiHandler({
  access: allow.user(),
  body: 'none',
  // Keyed on (user, client address): user-only would let a stolen session
  // lock the owner out, address-only would be unfair behind a shared NAT.
  // Shared with the request endpoint (same namespace), so alternating
  // requests and cancels can't pump the audit log.
  rateLimit: { namespace: 'account-delete-request', max: 5, windowMs: HOUR_MS, key: 'user+ip', error: 'account/delete-rate-limited' },
  handler: async ({ event, user }) => {
    const userId = user.id

    const ip = getClientIp(event)

    try {
      const result = await cancelAccountDeletionByUser({
        userId,
        actorIp: ip
      })

      return {
        ok: true,
        deletionRequestedAt: null,
        deletionGraceUntil: null,
        emailAttempted: result.emailAttempted
      }
    } catch (e) {
      if (isRepoError(e)) {
        throw apiError('account/delete-cancel-conflict', undefined, { status: e.httpStatus as 409 | 404, cause: e })
      }
      throw e
    }
  }
})
