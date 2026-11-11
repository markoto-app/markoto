import { confirmWaitlistSignup } from '../../repos/waitlist'
import { hashWaitlistToken, parseWaitlistToken } from '../../utils/privacy/waitlist'
import { MINUTE_MS } from '~~/shared/config/units'

// POST /api/waitlist/confirm: second step of the double opt-in. Body:
// { token } (the raw confirm token from the email link). The
// `/waitlist/confirm` page POSTs it on an explicit button click, not on page
// load, so link-scanning mail filters can't confirm for the person.
//
// Works regardless of billing mode: a sign-up made while the waitlist was open
// can still be confirmed after a config change. Public (whitelisted in
// middleware/auth.ts); a 256-bit token isn't brute-forceable and the IP limit
// only caps garbage traffic.
//
// 200 { confirmed: true }; 400 `waitlist/invalid-token` for a malformed,
// unknown, used or expired token (one response for all, no oracle).

export default defineEventHandler(async (event) => {
  const ip = getClientRateLimitKey(event)
  if (!(await checkRateLimit('waitlist-token', ip, 30, 10 * MINUTE_MS))) {
    throw createError({
      statusCode: 429,
      message: 'Too many requests. Try again later.',
      data: { code: 'waitlist/rate-limited', messageKey: 'error.rateLimited' }
    })
  }

  const body = await readBody<{ token?: unknown }>(event)
  const token = parseWaitlistToken(body?.token)
  const confirmed = token ? await confirmWaitlistSignup(hashWaitlistToken(token)) : false
  if (!confirmed) {
    throw createError({
      statusCode: 400,
      message: 'This confirmation link is invalid or has expired.',
      data: { code: 'waitlist/invalid-token', messageKey: 'waitlist.errors.invalidToken' }
    })
  }
  return { confirmed: true }
})
