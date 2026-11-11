import { deleteWaitlistSignupByUnsubscribeToken } from '../../repos/waitlist'
import { hashWaitlistToken, parseWaitlistToken } from '../../utils/privacy/waitlist'
import { MINUTE_MS } from '~~/shared/config/units'
import { waitlistTokenBody } from '~~/shared/api/legal'

// POST /api/waitlist/unsubscribe: withdraws consent and DELETES the row. Body:
// { token } (the raw unsubscribe token from the email). Like confirm, the page
// sends it on an explicit click so a link-prefetching scanner can't remove
// someone silently.
//
// Always available (GDPR Art.7(3): withdrawing must not depend on a feature
// flag). Public.
//
// Idempotent: a well-formed token always gets 200 { unsubscribed: true },
// matched or not, so the response reveals nothing. Only a malformed token is
// a 400.

export default defineApiHandler({
  access: allow.public('Link target of the waitlist emails; the single-use token is the credential and withdrawing consent must work without a session or a feature flag'),
  body: waitlistTokenBody,
  rateLimit: { namespace: 'waitlist-token', max: 30, windowMs: 10 * MINUTE_MS, key: 'ip', error: 'waitlist/rate-limited' },
  handler: async ({ body }) => {
    const token = parseWaitlistToken(body?.token)
    if (!token) throw apiError('waitlist/invalid-token')
    await deleteWaitlistSignupByUnsubscribeToken(hashWaitlistToken(token))
    return { unsubscribed: true }
  }
})
