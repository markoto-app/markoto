import { cancelAccountDeletionByUser } from '../../utils/accountDeletion'
import { checkRateLimit } from '../../utils/rateLimit'
import { isRepoError } from '../../repos/errors'

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

export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const userId = session.user.id

  const ip = getClientIp(event)

  // Same rate-limit key as the request endpoint so the budget is
  // shared — a stolen session can't burst-cancel-then-burst-request.
  const rlKey = `${userId}:${getClientRateLimitKey(event)}`
  if (!(await checkRateLimit('account-delete-request', rlKey, 5, 60 * 60 * 1000))) {
    throw createError({
      statusCode: 429,
      message: 'Too many account-deletion requests. Try again later.',
      data: { code: 'account/delete-rate-limited' }
    })
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
      throw createError({
        statusCode: e.httpStatus,
        message: e.message,
        data: { code: 'account/delete-cancel-conflict' }
      })
    }
    throw e
  }
})
