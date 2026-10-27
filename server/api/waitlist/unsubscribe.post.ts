import { deleteWaitlistSignupByUnsubscribeToken } from '../../repos/waitlist'
import { hashWaitlistToken, parseWaitlistToken } from '../../utils/waitlist'

// POST /api/waitlist/unsubscribe — withdraw consent; DELETES the row.
//
// Body: { token: string } — the raw unsubscribe token from the email.
// Like confirm, the `/waitlist/unsubscribe` page sends it on an explicit
// click so a link-prefetching scanner can't remove someone silently.
//
// Always available (withdrawing consent must never depend on a feature
// flag — GDPR Art.7(3): as easy to withdraw as to give). Public
// (whitelisted in middleware/auth.ts).
//
// Idempotent: a well-formed token always gets 200 { unsubscribed: true },
// whether or not a row matched (already removed, never existed) — the
// person's goal "not on the list" holds either way, and the response
// reveals nothing. Only a malformed token is a 400.

export default defineEventHandler(async (event) => {
  const ip = getClientRateLimitKey(event)
  if (!(await checkRateLimit('waitlist-token', ip, 30, 10 * 60 * 1000))) {
    throw createError({
      statusCode: 429,
      message: 'Too many requests. Try again later.',
      data: { code: 'waitlist/rate-limited', messageKey: 'error.rateLimited' }
    })
  }

  const body = await readBody<{ token?: unknown }>(event)
  const token = parseWaitlistToken(body?.token)
  if (!token) {
    throw createError({
      statusCode: 400,
      message: 'This unsubscribe link is invalid.',
      data: { code: 'waitlist/invalid-token', messageKey: 'waitlist.errors.invalidToken' }
    })
  }
  await deleteWaitlistSignupByUnsubscribeToken(hashWaitlistToken(token))
  return { unsubscribed: true }
})
