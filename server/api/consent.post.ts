import { createHash } from 'node:crypto'
import { consentLog } from '../db/schema'
import { useDatabase } from '../utils/database'
import { truncateIp } from '../repos/audit'
import { CONSENT_VERSION, AUTHORITATIVE_LOCALE, LEGAL_DOCUMENT_LOCALES } from '~~/shared/legal/versions'
import { ensureAnonId } from '../utils/anonId'

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
  decisions: Array<{
    purpose: 'essential' | 'analytics' | 'session_replay'
    granted: boolean
  }>
  locale?: string
}

const ALLOWED_PURPOSES = ['essential', 'analytics', 'session_replay'] as const

export default defineEventHandler(async (event) => {
  const body = await readBody<RequestBody>(event)
  if (!body || !Array.isArray(body.decisions) || body.decisions.length === 0) {
    throw createError({ statusCode: 400, message: 'No decisions provided' })
  }

  // Normalise the input: each decision must be a known purpose +
  // a boolean. Filter out anything else rather than 400-ing the
  // whole batch — partial saves of valid decisions are friendlier
  // than rejecting the request on a stray key.
  const valid = body.decisions.filter(d =>
    ALLOWED_PURPOSES.includes(d.purpose) && typeof d.granted === 'boolean'
  )
  if (valid.length === 0) {
    throw createError({ statusCode: 400, message: 'No valid decisions in payload' })
  }

  // Locale fallback — the consent record stores which language
  // the user actually saw the banner in. Important for forensics
  // ("did they understand what they consented to?").
  const locale = LEGAL_DOCUMENT_LOCALES.includes(
    body.locale as (typeof LEGAL_DOCUMENT_LOCALES)[number]
  ) ? body.locale! : AUTHORITATIVE_LOCALE

  const session = await getValidatedUserSession(event)
  const userId = session?.user?.id ?? null
  const anonId = await ensureAnonId(event)

  // Truncate IP + hash UA — same audit-log convention. Storing
  // raw values would re-introduce identifying data we just
  // pseudonymised.
  const rawIp = getRequestHeader(event, 'x-forwarded-for')?.split(',')[0]?.trim()
    || getRequestHeader(event, 'x-real-ip')
    || null
  const ipTruncated = truncateIp(rawIp)
  const userAgent = getRequestHeader(event, 'user-agent') ?? ''
  const userAgentHash = userAgent
    ? createHash('sha256').update(userAgent).digest('hex')
    : null

  const db = useDatabase()
  // Bulk INSERT — drizzle expands the array into one statement.
  // No conflict handling because the table is append-only;
  // duplicate decisions just create duplicate rows (the read path
  // takes the latest).
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
