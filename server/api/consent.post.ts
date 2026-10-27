import { createHash } from 'node:crypto'
import { consentLog } from '../db/schema'
import { useDatabase } from '../utils/database'
import { truncateIp } from '../repos/audit'
import { CONSENT_VERSION, AUTHORITATIVE_LOCALE, LEGAL_DOCUMENT_LOCALES } from '~~/shared/legal/versions'
import { ensureAnonId } from '../utils/anonId'
import { normaliseConsentDecisions } from '../utils/consentDecisions'

// Append a consent decision to the audit-grade `consent_log` table.
// One row per (subject × purpose) per submission — we never UPDATE,
// only INSERT. The latest row per (subject, purpose) is what the
// runtime reads via `GET /api/consent`.
//
// Withdrawing consent is recorded as a NEW row with `granted=false`
// at the current version. This preserves the historical trail
// (regulator-style "show me the user's consent decisions over
// time").
//
// Anonymous users get an `anon_id` first-party cookie via
// `ensureAnonId` so a returning visitor sees their prior choice.
// Logged-in users get `user_id` populated AND `anon_id` mirrored —
// the linkage helps if a user logs in mid-session and we want to
// associate their pre-login decision.

interface RequestBody {
  decisions?: unknown
  locale?: string
}

// Public + append-only: bound the write rate per client (IPv4 / IPv6 /64).
// A real visitor submits the banner a handful of times at most.
const CONSENT_RATE_LIMIT = 20
const CONSENT_RATE_WINDOW_MS = 10 * 60 * 1000

export default defineEventHandler(async (event) => {
  if (!(await checkRateLimit('consent', getClientRateLimitKey(event), CONSENT_RATE_LIMIT, CONSENT_RATE_WINDOW_MS))) {
    throw createError({
      statusCode: 429,
      message: 'Too many consent submissions. Try again later.',
      data: { code: 'consent/rate-limited', messageKey: 'error.rateLimited' }
    })
  }

  const body = await readBody<RequestBody>(event)
  // At most one row per purpose per submission (last decision for a
  // purpose wins); unknown purposes / non-boolean values are dropped
  // rather than 400-ing the whole batch, but an empty or oversized
  // array is refused.
  const valid = normaliseConsentDecisions(body?.decisions)
  if (valid === null) {
    throw createError({ statusCode: 400, message: 'No decisions provided' })
  }
  if (valid.length === 0) {
    throw createError({ statusCode: 400, message: 'No valid decisions in payload' })
  }

  // Locale fallback — the consent record stores which language
  // the user actually saw the banner in. Important for forensics
  // ("did they understand what they consented to?").
  const locale = LEGAL_DOCUMENT_LOCALES.includes(
    body.locale as (typeof LEGAL_DOCUMENT_LOCALES)[number]
  )
    ? body.locale!
    : AUTHORITATIVE_LOCALE

  const session = await getValidatedUserSession(event)
  const userId = session?.user?.id ?? null
  const anonId = await ensureAnonId(event)

  // Truncate IP + hash UA — same audit-log convention. Storing
  // raw values would re-introduce identifying data we just
  // pseudonymised.
  const rawIp = getClientIp(event)
  const ipTruncated = truncateIp(rawIp)
  const userAgent = getRequestHeader(event, 'user-agent') ?? ''
  const userAgentHash = userAgent
    ? createHash('sha256').update(userAgent).digest('hex')
    : null

  const db = useDatabase()
  // Bulk INSERT — drizzle expands the array into one statement.
  // No conflict handling because the table is append-only; repeated
  // submissions create new rows (the read path takes the latest).
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
