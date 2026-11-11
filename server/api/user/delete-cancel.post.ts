import { cancelAccountDeletionByUser } from '../../utils/privacy/accountDeletion'
import { checkRateLimit } from '../../utils/platform/rateLimit'
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
  handler: async ({ event, user }) => {
    const userId = user.id

    const ip = getClientIp(event)

    // Same rate-limit key as the request endpoint so the budget is
    // shared — a stolen session can't burst-cancel-then-burst-request.
    // Inline: the wrapper's per-user key has no client address.
    const rlKey = `${userId}:${getClientRateLimitKey(event)}`
    if (!(await checkRateLimit('account-delete-request', rlKey, 5, HOUR_MS))) {
      throw apiError('account/delete-rate-limited')
    }

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
