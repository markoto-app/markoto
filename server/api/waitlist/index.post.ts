import { upsertWaitlistSignup } from '../../repos/waitlist'
import { safeSendTransactionalEmail } from '../../utils/email/sendEmail'
import { emailLinkBaseUrl } from '../../utils/platform/siteUrl'
import {
  WAITLIST_CONFIRM_TTL_MS,
  WAITLIST_DISABLED_CODE,
  buildWaitlistConfirmEmail,
  generateWaitlistToken,
  hashWaitlistToken,
  isWaitlistOpen,
  normaliseWaitlistEmail,
  normaliseWaitlistLocale
} from '../../utils/privacy/waitlist'
import { WAITLIST_CONSENT_TEXT_ID, WAITLIST_CONSENT_VERSION } from '~~/shared/legal/versions'
import { DAY_MS, HOUR_MS } from '~~/shared/config/units'

// POST /api/waitlist: join the paid-plans waitlist (double opt-in). Body:
// { email, locale?, consent: true }.
//
// Public (whitelisted in middleware/auth.ts); a signed-in caller's account is
// linked to the row so account deletion + data export cover it. Only available
// while the waitlist is open (billing off AND NUXT_PLANS_COMING_SOON), else 404
// `waitlist/disabled`.
//
// The response is ALWAYS `202 { ok: true }` for a well-formed request (new,
// pending, confirmed or throttled address) so the endpoint isn't an oracle for
// "is this email on the list". Only a new or unconfirmed address gets an email.
//
// Limits (Valkey, fail-open like every request limiter): 5 sign-ups per IP per
// hour (429, reveals nothing about any address); 3 confirmation emails per
// address per 24 h, silently skipped so we can't be used to mail-bomb a third
// party. No IP is stored; it only keys the counter.

const IP_LIMIT = 5
const IP_WINDOW_MS = HOUR_MS
const EMAIL_LIMIT = 3
const EMAIL_WINDOW_MS = DAY_MS

export default defineEventHandler(async (event) => {
  if (!isWaitlistOpen()) {
    throw createError({
      statusCode: 404,
      statusMessage: 'Not Found',
      message: 'The waitlist is not available on this deployment.',
      data: { code: WAITLIST_DISABLED_CODE }
    })
  }

  const ip = getClientRateLimitKey(event)
  if (!(await checkRateLimit('waitlist-signup', ip, IP_LIMIT, IP_WINDOW_MS))) {
    throw createError({
      statusCode: 429,
      message: 'Too many sign-up attempts. Try again later.',
      data: { code: 'waitlist/rate-limited', messageKey: 'error.rateLimited' }
    })
  }

  const body = await readBody<{ email?: unknown, locale?: unknown, consent?: unknown }>(event)
  // Consent must be an explicit `true` from the unticked checkbox (GDPR
  // Art.4(11)/7: a clear affirmative act, never a default).
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

  // Per-address throttle keyed on a hash so raw addresses never sit in Valkey.
  // Over the limit: same 202 as success, no email.
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

  // Links are built from NUXT_SITE_URL only, never request Host /
  // X-Forwarded-* (client-influenced: a poisoned host would mail the
  // single-use tokens to an attacker's domain). Without a site URL (only
  // possible outside production) the email is skipped; the response stays 202.
  const baseUrl = emailLinkBaseUrl(useRuntimeConfig(event).siteUrl)
  if (outcome !== 'unchanged' && baseUrl === null) {
    console.warn('[waitlist] NUXT_SITE_URL is not set — confirmation email not sent')
  }
  if (outcome !== 'unchanged' && baseUrl !== null) {
    const content = buildWaitlistConfirmEmail({ locale, baseUrl, confirmToken, unsubscribeToken })
    // Fire-and-forget: the row is committed, a delivery failure is
    // Sentry-captured, and the person can resubmit (tokens rotate on re-signup).
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
