import { confirmWaitlistSignup } from '../../repos/waitlist'
import { hashWaitlistToken, parseWaitlistToken } from '../../utils/waitlist'

// POST /api/waitlist/confirm — second step of the double opt-in.
//
// Body: { token: string } — the raw confirm token from the email link.
// The `/waitlist/confirm` page POSTs it on an explicit button click
// (not on page load) so link-scanning mail filters that prefetch URLs
// can't confirm on the person's behalf.
//
// Works regardless of the billing mode: a sign-up made while the
// waitlist was open can still be confirmed after a config change.
// Public (whitelisted in middleware/auth.ts). A 256-bit token is not
// brute-forceable; the IP limit only caps garbage traffic.
//
// 200 { confirmed: true } on success; 400 `waitlist/invalid-token` for
// a malformed, unknown, already-used or expired token (one response for
// all four — no oracle).

export default defineEventHandler(async (event) => {
  const ip = getClientIp(event) ?? 'unknown'
  if (!(await checkRateLimit('waitlist-token', ip, 30, 10 * 60 * 1000))) {
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
