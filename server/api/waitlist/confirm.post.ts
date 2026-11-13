import { confirmWaitlistSignup } from '../../repos/waitlist'
import { hashWaitlistToken, parseWaitlistToken } from '../../utils/privacy/waitlist'
import { MINUTE_MS } from '~~/shared/config/units'
import { waitlistTokenBody } from '~~/shared/api/legal'

// POST /api/waitlist/confirm: second step of the double opt-in. Body:
// { token } (the raw confirm token from the email link). The
// `/waitlist/confirm` page POSTs it on an explicit button click, not on page
// load, so link-scanning mail filters can't confirm for the person.
//
// Works regardless of billing mode: a sign-up made while the waitlist was open
// can still be confirmed after a config change. Public; a 256-bit token isn't brute-forceable and the IP limit
// only caps garbage traffic.
//
// 200 { confirmed: true }; 400 `waitlist/invalid-token` for a malformed,
// unknown, used or expired token (one response for all, no oracle).

export default defineApiHandler({
  access: allow.public('Link target of the double opt-in email; the single-use 256-bit token is the credential, the per-client limit caps garbage traffic'),
  body: waitlistTokenBody,
  rateLimit: { namespace: 'waitlist-token', max: 30, windowMs: 10 * MINUTE_MS, key: 'ip', error: 'waitlist/rate-limited' },
  handler: async ({ body }) => {
    const token = parseWaitlistToken(body?.token)
    const confirmed = token ? await confirmWaitlistSignup(hashWaitlistToken(token)) : false
    if (!confirmed) throw apiError('waitlist/invalid-token')
    return { confirmed: true }
  }
})
