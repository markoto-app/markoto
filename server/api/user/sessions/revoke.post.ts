import { bumpSessionEpoch } from '../../../repos/users'
import { appendAuditEvent } from '../../../repos/audit'
import { AUDIT_ACCOUNT_SESSIONS_REVOKED } from '../../../legal/auditActions'
import { HOUR_MS } from '~~/shared/config/units'

// POST /api/user/sessions/revoke — "log out everywhere".
//
// Session cookies are sealed client-side state and can't be recalled
// one by one, so this bumps the user's session epoch: every cookie
// sealed before now (other browsers, devices, a copied cookie) fails
// validation on its next request. This browser's cookie is cleared too;
// the client then runs the normal logout clean-up and reloads.
//
// Not behind the recent-sign-in requirement — logging out can only
// reduce what a session holder is able to do. Rate-limited per user so
// a script can't spin the audit log.
export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const userId = session.user.id

  if (!(await checkRateLimit('sessions-revoke', String(userId), 10, HOUR_MS))) {
    throw createError({
      statusCode: 429,
      message: 'Too many requests. Try again later.',
      data: { code: 'account/sessions-revoke-rate-limited', messageKey: 'error.rateLimited' }
    })
  }

  await bumpSessionEpoch(userId)
  await clearUserSession(event)

  await appendAuditEvent({
    actorUserId: userId,
    actorIp: getClientIp(event),
    scope: 'user',
    scopeId: String(userId),
    action: AUDIT_ACCOUNT_SESSIONS_REVOKED,
    before: null,
    after: null
  })

  return { ok: true }
})
