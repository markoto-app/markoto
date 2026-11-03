import { issueAnonChallenge } from '../../utils/anonGate/gate'
import { isAnonGatePurpose } from '~~/shared/config/anonGate'

// ALTCHA challenge for an anonymous visitor (self-hosted proof of work,
// see server/utils/anonGate/altcha.ts). `?purpose=doc-create|abuse-report`
// is signed into the challenge. Also reports whether this browser has
// already accepted the current terms (so the UI can skip the checkbox).
//
// Public (whitelisted in middleware/auth.ts), never cached, IP-limited:
// creating a challenge costs the server one PBKDF2 derivation.

export default defineEventHandler(async (event) => {
  const key = getClientRateLimitKey(event)
  if (!(await checkRateLimit('anon-gate-challenge', key, 60, 60_000))) {
    throw createError({
      statusCode: 429,
      message: 'Too many requests. Try again in a minute.',
      data: { code: 'anon-gate/rate-limited', messageKey: 'error.rateLimited' }
    })
  }
  const purpose = getQuery(event).purpose ?? 'doc-create'
  if (!isAnonGatePurpose(purpose)) {
    throw createError({ statusCode: 400, message: 'Unknown purpose' })
  }
  setResponseHeader(event, 'Cache-Control', 'no-store')
  return issueAnonChallenge(event, purpose)
})
