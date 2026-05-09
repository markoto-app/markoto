import { createHash } from 'node:crypto'
import { nanoid } from 'nanoid'
import { abuseReports } from '../db/schema'
import { useDatabase } from '../utils/database'
import { truncateIp, appendAuditEvent } from '../repos/audit'
import { AUDIT_ABUSE_REPORTED } from '../legal/auditActions'
import { checkRateLimit } from '../utils/rateLimit'
import { findUserById } from '../repos/users'
import { safeSendTransactionalEmail } from '../utils/email/sendEmail'
import { resolveLegalEntity } from '~~/shared/legal/entity'

// DSA Article 16 notice-and-action submission. Records a structured
// report in `abuse_reports` (status='open', triage queue), audit-
// logs the event, and returns the report id so the user has a
// reference number.
//
// **Login required.** The public/anonymous reporting channel is the
// `abuseContactEmail` documented in `/legal/abuse-policy` — DSA
// Article 16 requires the platform to ACCEPT notices from anyone,
// not that the form must be public. Login-gating the form gives
// us spam protection (1 report per minute per user, plus name +
// id are recorded as `actor_user_id`) without violating the
// anonymous-channel obligation.
//
// Rate limit: 10 reports per user per hour. Higher than typical
// abuse rate-limits (we want to catch genuinely bad content even
// when it's flooded) but tight enough that a compromised account
// can't pump the queue.

interface RequestBody {
  docId?: string | null
  category: 'illegal_content' | 'copyright' | 'csam' | 'harassment' | 'spam' | 'other'
  body: string
}

const ALLOWED_CATEGORIES = ['illegal_content', 'copyright', 'csam', 'harassment', 'spam', 'other'] as const

export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const userId = session.user.id

  if (!(await checkRateLimit('abuse-report', String(userId), 10, 60 * 60 * 1000))) {
    throw createError({
      statusCode: 429,
      message: 'Too many reports submitted recently. Try again later.',
      data: { code: 'abuse/rate-limited' }
    })
  }

  const body = await readBody<RequestBody>(event)
  if (!body || typeof body !== 'object') {
    throw createError({ statusCode: 400, message: 'Invalid request body' })
  }
  if (!ALLOWED_CATEGORIES.includes(body.category)) {
    throw createError({ statusCode: 400, message: 'Invalid category' })
  }
  const reportBody = typeof body.body === 'string' ? body.body.trim() : ''
  if (reportBody.length < 10) {
    throw createError({ statusCode: 400, message: 'Please describe what should be reviewed (at least 10 characters).' })
  }
  if (reportBody.length > 5000) {
    throw createError({ statusCode: 400, message: 'Report body too long (max 5000).' })
  }

  // Optional doc-id pointer. If present, must be a plausible doc id
  // shape (we don't pre-resolve to a row — moderators check the URL
  // when triaging; a malformed/nonexistent id is just informational
  // for the moderator review).
  const docId = typeof body.docId === 'string' && body.docId.trim().length > 0
    ? body.docId.trim().slice(0, 64)
    : null

  // Reporter identity capture: truncated IP + UA hash. Same audit-
  // log convention. The reporter's email comes from the user's
  // session profile (we already have it on `users.email` if they
  // signed in via OAuth).
  const rawIp = getRequestHeader(event, 'x-forwarded-for')?.split(',')[0]?.trim()
    || getRequestHeader(event, 'x-real-ip')
    || null
  const userAgent = getRequestHeader(event, 'user-agent') ?? ''
  const userAgentHash = userAgent
    ? createHash('sha256').update(userAgent).digest('hex')
    : null

  // Snapshot the reporter's name + email at submission time. The
  // FK column gives us a live pointer for follow-up (mailto:,
  // user lookup); the snapshot is the durable record if the
  // reporter later deletes their account (the FK auto-nulls,
  // but the email column survives so the moderator can still
  // see who originally reported).
  const reporterUser = await findUserById(userId)

  const reportId = `rep-${nanoid(16)}`
  const db = useDatabase()
  await db.insert(abuseReports).values({
    reportId,
    docId,
    reporterUserId: userId,
    reporterEmail: reporterUser?.email ?? null,
    reporterIpTruncated: truncateIp(rawIp),
    reporterUserAgentHash: userAgentHash,
    category: body.category,
    body: reportBody,
    status: 'open'
  })

  await appendAuditEvent({
    actorUserId: userId,
    actorIp: rawIp,
    scope: 'system',
    scopeId: reportId,
    action: AUDIT_ABUSE_REPORTED,
    metadata: {
      reportId,
      category: body.category,
      docId
    }
  })

  // Best-effort operator notification. Routed to the abuse contact
  // address, which is also the public reporting channel — same
  // inbox triages email reports + form reports. The email is
  // fire-and-forget; row + audit have already committed.
  const reporter = reporterUser
  const entity = resolveLegalEntity()
  void safeSendTransactionalEmail({
    kind: 'breach.notification', // closest existing kind label; the body distinguishes
    to: entity.abuseContactEmail,
    locale: null,
    subject: `[markoto abuse] ${body.category} report ${reportId}`,
    body: [
      `New abuse report submitted via the in-product form.`,
      ``,
      `Report ID: ${reportId}`,
      `Category: ${body.category}`,
      `Document: ${docId ?? '(platform-wide)'}`,
      `Reporter: ${reporter?.name ?? '(unknown)'} (id ${userId}, email ${reporter?.email ?? '(none)'})`,
      `IP (truncated): ${truncateIp(rawIp) ?? '(none)'}`,
      ``,
      `Body:`,
      reportBody,
      ``,
      `Triage at: /admin/abuse-reports`
    ].join('\n'),
    metadata: {
      reportId,
      category: body.category,
      docId: docId ?? '',
      reporterUserId: userId
    }
  })

  return { ok: true, reportId }
})
