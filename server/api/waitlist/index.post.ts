import { upsertWaitlistSignup } from '../../repos/waitlist'
import { safeSendTransactionalEmail } from '../../utils/email/sendEmail'
import {
  WAITLIST_CONFIRM_TTL_MS,
  WAITLIST_DISABLED_CODE,
  buildWaitlistConfirmEmail,
  generateWaitlistToken,
  hashWaitlistToken,
  isWaitlistOpen,
  normaliseWaitlistEmail,
  normaliseWaitlistLocale
} from '../../utils/waitlist'
import { WAITLIST_CONSENT_TEXT_ID, WAITLIST_CONSENT_VERSION } from '~~/shared/legal/versions'

// POST /api/waitlist — join the paid-plans waitlist (double opt-in).
//
// Public (whitelisted in middleware/auth.ts); a signed-in caller's
// account is linked to the row so account deletion + data export cover
// it. Only available while the waitlist is open (billing off AND
// NUXT_PLANS_COMING_SOON) — otherwise 404 `waitlist/disabled`.
//
// Body: { email: string, locale?: string, consent: true }
//
// Response is ALWAYS `202 { ok: true }` for a well-formed request,
// whether the address is new, pending, already confirmed, or throttled
// — the endpoint must not become an oracle for "is this email on the
// list". Only a new or still-unconfirmed address gets an email.
//
// Abuse limits (Valkey, fail-open like every request limiter):
//   - 5 sign-ups per IP per hour → 429 (the caller sees it; it reveals
//     nothing about any address).
//   - 3 confirmation emails per address per 24 h → silently skipped, so
//     nobody can use us to mail-bomb a third party's inbox.
//
// No IP address is stored; the IP only keys the Valkey counter.

const IP_LIMIT = 5
const IP_WINDOW_MS = 60 * 60 * 1000
const EMAIL_LIMIT = 3
const EMAIL_WINDOW_MS = 24 * 60 * 60 * 1000

export default defineEventHandler(async (event) => {
  if (!isWaitlistOpen()) {
    throw createError({
      statusCode: 404,
      statusMessage: 'Not Found',
      message: 'The waitlist is not available on this deployment.',
      data: { code: WAITLIST_DISABLED_CODE }
    })
  }

  const ip = getClientIp(event) ?? 'unknown'
  if (!(await checkRateLimit('waitlist-signup', ip, IP_LIMIT, IP_WINDOW_MS))) {
    throw createError({
      statusCode: 429,
      message: 'Too many sign-up attempts. Try again later.',
      data: { code: 'waitlist/rate-limited', messageKey: 'error.rateLimited' }
    })
  }

  const body = await readBody<{ email?: unknown, locale?: unknown, consent?: unknown }>(event)
  // Consent must be an explicit `true` from the unticked checkbox —
  // GDPR Art.4(11)/7: a clear affirmative act, never a default.
  if (body?.consent !== true) {
    throw createError({
      statusCode: 400,
      message: 'Consent is required to join the waitlist.',
      data: { code: 'waitlist/consent-required', messageKey: 'waitlist.errors.consentRequired' }
    })
  }
  const email = normaliseWaitlistEmail(body.email)
  if (!email) {
    throw createError({
      statusCode: 400,
      message: 'Please enter a valid email address.',
      data: { code: 'waitlist/invalid-email', messageKey: 'waitlist.errors.invalidEmail' }
    })
  }
  const locale = normaliseWaitlistLocale(body.locale)

  // Per-address throttle, keyed on a hash so raw addresses never sit in
  // Valkey. Over the limit → same 202 as success, no email.
  const emailKey = hashWaitlistToken(email)
  if (!(await checkRateLimit('waitlist-email', emailKey, EMAIL_LIMIT, EMAIL_WINDOW_MS))) {
    setResponseStatus(event, 202)
    return { ok: true }
  }

  const session = await getValidatedUserSession(event)
  const userId = session?.user?.id ?? null

  const confirmToken = generateWaitlistToken()
  const unsubscribeToken = generateWaitlistToken()
  const outcome = await upsertWaitlistSignup({
    email,
    locale,
    consentVersion: WAITLIST_CONSENT_VERSION,
    consentTextId: WAITLIST_CONSENT_TEXT_ID,
    userId,
    confirmTokenHash: hashWaitlistToken(confirmToken),
    confirmTokenExpiresAt: new Date(Date.now() + WAITLIST_CONFIRM_TTL_MS),
    unsubscribeTokenHash: hashWaitlistToken(unsubscribeToken)
  })

  if (outcome !== 'unchanged') {
    const configured = useRuntimeConfig(event).siteUrl
    const baseUrl = typeof configured === 'string' && configured.length > 0
      ? configured
      : getRequestURL(event, { xForwardedProto: true }).origin
    const content = buildWaitlistConfirmEmail({ locale, baseUrl, confirmToken, unsubscribeToken })
    // Fire-and-forget like every transactional email: the row is
    // committed; a delivery failure is Sentry-captured, and the person
    // can simply submit again (tokens rotate on re-signup).
    void safeSendTransactionalEmail({
      kind: 'waitlist.confirm',
      to: email,
      locale,
      subject: content.subject,
      body: content.body,
      bodyContainsSecrets: true,
      metadata: { outcome }
    })
  }

  setResponseStatus(event, 202)
  return { ok: true }
})
