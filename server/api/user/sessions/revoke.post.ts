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
export default defineApiHandler({
  access: allow.user(),
  body: 'none',
  rateLimit: { namespace: 'sessions-revoke', max: 10, windowMs: HOUR_MS, key: 'user', error: 'account/sessions-revoke-rate-limited' },
  handler: async ({ event, user, self }) => {
    const userId = user.id

    await bumpSessionEpoch(self)
    await clearUserSession(event)

    await appendAuditEvent({
      by: self,
      actorIp: getClientIp(event),
      scope: 'user',
      scopeId: String(userId),
      action: AUDIT_ACCOUNT_SESSIONS_REVOKED,
      before: null,
      after: null
    })

    return { ok: true }
  }
})
