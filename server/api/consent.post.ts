import { createHash } from 'node:crypto'
import { consentLog } from '../db/schema'
import { useDatabase } from '../utils/platform/database'
import { truncateIp } from '../repos/audit'
import { CONSENT_VERSION, AUTHORITATIVE_LOCALE, LEGAL_DOCUMENT_LOCALES } from '~~/shared/legal/versions'
import { ensureAnonId } from '../utils/auth/anonId'
import { normaliseConsentDecisions } from '../utils/privacy/consentDecisions'
import { MINUTE_MS } from '~~/shared/config/units'

// Appends consent decisions to the audit-grade `consent_log`: one INSERT per
// (subject x purpose) per submission, never UPDATE; `GET /api/consent` reads
// the latest row. Withdrawal is a NEW row with `granted=false` at the current
// version, preserving the history a regulator may ask for.
//
// Anonymous users get an `anon_id` cookie (`ensureAnonId`) so a returning
// visitor sees their prior choice; logged-in users get `user_id` AND `anon_id`
// so a mid-session login can be linked to the pre-login decision.

interface RequestBody {
  decisions?: unknown
  locale?: string
}

// Public + append-only: bound the write rate per client (IPv4 / IPv6 /64).
// A real visitor submits the banner a handful of times at most.
const CONSENT_RATE_LIMIT = 20
const CONSENT_RATE_WINDOW_MS = 10 * MINUTE_MS

export default defineEventHandler(async (event) => {
  if (!(await checkRateLimit('consent', getClientRateLimitKey(event), CONSENT_RATE_LIMIT, CONSENT_RATE_WINDOW_MS))) {
    throw createError({
      statusCode: 429,
      message: 'Too many consent submissions. Try again later.',
      data: { code: 'consent/rate-limited', messageKey: 'error.rateLimited' }
    })
  }

  const body = await readBody<RequestBody>(event)
  // One row per purpose per submission (last decision wins); unknown purposes
  // and non-boolean values are dropped rather than 400-ing the batch, but an
  // empty or oversized array is refused.
  const valid = normaliseConsentDecisions(body?.decisions)
  if (valid === null) {
    throw createError({ statusCode: 400, message: 'No decisions provided' })
  }
  if (valid.length === 0) {
    throw createError({ statusCode: 400, message: 'No valid decisions in payload' })
  }

  // The record stores the language the user actually saw the banner in.
  const locale = LEGAL_DOCUMENT_LOCALES.includes(
    body.locale as (typeof LEGAL_DOCUMENT_LOCALES)[number]
  )
    ? body.locale!
    : AUTHORITATIVE_LOCALE

  const session = await getValidatedUserSession(event)
  const userId = session?.user?.id ?? null
  const anonId = await ensureAnonId(event)

  // Truncate IP + hash UA (same as the audit log): raw values would
  // re-introduce identifying data.
  const rawIp = getClientIp(event)
  const ipTruncated = truncateIp(rawIp)
  const userAgent = getRequestHeader(event, 'user-agent') ?? ''
  const userAgentHash = userAgent
    ? createHash('sha256').update(userAgent).digest('hex')
    : null

  const db = useDatabase()
  // Append-only: no conflict handling; the read path takes the latest row.
  await db.insert(consentLog).values(valid.map(d => ({
    userId,
    anonId,
    purpose: d.purpose,
    granted: d.granted,
    version: CONSENT_VERSION,
    locale,
    ipTruncated,
    userAgentHash
  })))

  return {
    ok: true,
    version: CONSENT_VERSION,
    recorded: valid.length
  }
})
