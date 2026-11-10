import { docIdForPublishedUrl } from '../utils/publish/takeDown'
import { createHash } from 'node:crypto'
import { nanoid } from 'nanoid'
import { abuseReports } from '../db/schema'
import { useDatabase } from '../utils/database'
import { truncateIp, appendAuditEvent } from '../repos/audit'
import { AUDIT_ABUSE_REPORTED } from '../legal/auditActions'
import { checkRateLimit } from '../utils/rateLimit'
import { findUserById } from '../repos/users'
import { safeSendTransactionalEmail } from '../utils/email/sendEmail'
import { abuseNotificationRecipient } from '../utils/instanceConfig'
import { anonGateEnabled, requireBotCheck } from '../utils/anonGate/gate'
import { buildReceiptNotice, deliverNotice } from '../utils/moderationNotices'
import { normaliseNoticeLocale } from '../utils/moderationNoticeCopy'
import { isValidEmailShape } from '../utils/emailShape'
import {
  REPORTER_NAME_MAX,
  REPORT_BODY_MAX,
  REPORT_BODY_MIN,
  REPORT_URL_MAX,
  contactOptionalFor,
  docIdFromReportedLocation,
  isReportCategory
} from '~~/shared/config/moderation'
import { ANON_ABUSE_REPORT_LIMITS, USER_ABUSE_REPORT_LIMIT } from '~~/shared/config/anonLimits'

// DSA Article 16 notice-and-action submission, open to everyone.
//
// Art.16(2) contents, all checked here:
//   (a) why the content is illegal / against the rules → `body`
//   (b) the exact location                              → `contentUrl`
//   (c) name + email of the reporter                    → `reporterName`,
//       `reporterEmail` (optional for CSAM reports; signed-in reporters
//       default to their profile)
//   (d) good-faith statement                            → `goodFaith: true`
//
// Anonymous reporters: a fresh ALTCHA solution (purpose `abuse-report`)
// + 5/hour and 20/day per client key. Without the anonymous gate
// (self-hosted default) the form needs a sign-in, as before. Signed-in
// reporters: 10/hour per user.
//
// On success: row + audit, a confirmation of receipt to the reporter
// (Art.16(4), recorded in `moderation_notices`) and a best-effort note to
// the operator's abuse inbox.

interface RequestBody {
  contentUrl?: unknown
  /** Legacy field of the pre-DSA form; treated like `contentUrl`. */
  docId?: unknown
  category?: unknown
  body?: unknown
  reporterName?: unknown
  reporterEmail?: unknown
  goodFaith?: unknown
  locale?: unknown
  altcha?: unknown
}

function trimmed(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function badRequest(message: string, code: string, messageKey: string): never {
  throw createError({ statusCode: 400, message, data: { code, messageKey } })
}

async function enforceRateLimits(userId: number | null, clientKey: string): Promise<void> {
  const rules = userId === null
    ? ANON_ABUSE_REPORT_LIMITS.map(r => ({ ...r, key: clientKey }))
    : [{ ...USER_ABUSE_REPORT_LIMIT, key: String(userId) }]
  for (const rule of rules) {
    if (!(await checkRateLimit(rule.namespace, rule.key, rule.max, rule.windowMs))) {
      throw createError({
        statusCode: 429,
        message: 'Too many reports submitted recently. Try again later.',
        data: { code: 'abuse/rate-limited', messageKey: 'legal.abuse.errors.rateLimited' }
      })
    }
  }
}

export default defineEventHandler(async (event) => {
  const session = await getValidatedUserSession(event)
  const userId = session?.user?.id ?? null

  if (userId === null && !anonGateEnabled()) {
    throw createError({
      statusCode: 401,
      message: 'Please sign in to report content.',
      data: { code: 'abuse/login-required', messageKey: 'legal.abuse.errors.loginRequired' }
    })
  }

  await enforceRateLimits(userId, getClientRateLimitKey(event))

  const raw = await readBody<RequestBody>(event).catch((): RequestBody => ({}))
  const input: RequestBody = raw && typeof raw === 'object' ? raw : {}

  const category = input.category
  if (!isReportCategory(category)) {
    badRequest('Invalid category', 'abuse/invalid-category', 'legal.abuse.errors.category')
  }
  const contentUrl = trimmed(input.contentUrl ?? input.docId, REPORT_URL_MAX)
  if (!contentUrl) {
    badRequest('Please give the address (URL) of the content.', 'abuse/url-required', 'legal.abuse.errors.urlRequired')
  }
  const reportBody = typeof input.body === 'string' ? input.body.trim() : ''
  if (reportBody.length < REPORT_BODY_MIN) {
    badRequest(`Please explain what is wrong with it (at least ${REPORT_BODY_MIN} characters).`, 'abuse/body-too-short', 'legal.abuse.errors.bodyTooShort')
  }
  if (reportBody.length > REPORT_BODY_MAX) {
    badRequest(`Report body too long (max ${REPORT_BODY_MAX}).`, 'abuse/body-too-long', 'legal.abuse.errors.bodyTooLong')
  }
  if (input.goodFaith !== true) {
    badRequest('Please confirm the statement that your report is accurate and made in good faith.', 'abuse/good-faith-required', 'legal.abuse.errors.goodFaith')
  }

  const reporterUser = userId === null ? null : await findUserById(userId)
  const reporterName = trimmed(input.reporterName, REPORTER_NAME_MAX) || (reporterUser?.name?.trim() ?? '')
  const typedEmail = trimmed(input.reporterEmail, 320).toLowerCase()
  if (typedEmail && !isValidEmailShape(typedEmail)) {
    badRequest('Please enter a valid email address.', 'abuse/invalid-email', 'legal.abuse.errors.email')
  }
  const reporterEmail = typedEmail || (reporterUser?.email ?? '')
  if (!contactOptionalFor(category) && (!reporterName || !reporterEmail)) {
    badRequest('Please give your name and email address.', 'abuse/contact-required', 'legal.abuse.errors.contactRequired')
  }

  // Anonymous: bot check last (after the cheap validation, so a typo
  // doesn't burn the solution).
  if (userId === null) {
    await requireBotCheck(event, input.altcha, 'abuse-report')
  }

  // A published page (WP13) is reported by its own address: /p/<slug> or a custom domain.
  const docId = docIdFromReportedLocation(contentUrl) ?? await docIdForPublishedUrl(contentUrl)
  const locale = normaliseNoticeLocale(input.locale)
  const rawIp = getClientIp(event)
  const userAgent = getRequestHeader(event, 'user-agent') ?? ''
  const userAgentHash = userAgent ? createHash('sha256').update(userAgent).digest('hex') : null

  const reportId = `rep-${nanoid(16)}`
  await useDatabase().insert(abuseReports).values({
    reportId,
    docId,
    contentUrl,
    reporterUserId: userId,
    reporterEmail: reporterEmail || null,
    reporterName: reporterName || null,
    reporterLocale: locale,
    goodFaithConfirmedAt: new Date(),
    reporterIpTruncated: truncateIp(rawIp),
    reporterUserAgentHash: userAgentHash,
    category,
    body: reportBody,
    status: 'open'
  })

  await appendAuditEvent({
    actorUserId: userId,
    actorIp: rawIp,
    scope: 'system',
    scopeId: reportId,
    action: AUDIT_ABUSE_REPORTED,
    metadata: { reportId, category, docId, anonymous: userId === null }
  })

  // Art.16(4): confirmation of receipt (recorded even when there is no
  // address to send it to — CSAM reports may be anonymous).
  await deliverNotice({
    reportId,
    kind: 'receipt',
    recipientRole: 'reporter',
    recipientUserId: userId,
    to: reporterEmail || null,
    locale,
    notice: buildReceiptNotice(locale, { reportId, contentUrl })
  })

  // Best-effort operator notification to the abuse inbox (also the email
  // reporting channel). A self-hosted instance without a configured inbox
  // gets none; the report is still in /admin/abuse-reports.
  void safeSendTransactionalEmail({
    kind: 'abuse.operator_notice',
    to: abuseNotificationRecipient(),
    locale: null,
    subject: `[markoto abuse] ${category} report ${reportId}`,
    body: [
      'New abuse report submitted via the form.',
      '',
      `Report ID: ${reportId}`,
      `Category: ${category}`,
      `Reported location: ${contentUrl}`,
      `Document id: ${docId ?? '(not recognised)'}`,
      `Reporter: ${reporterName || '(not given)'} <${reporterEmail || 'no email'}>${userId === null ? ' (not signed in)' : ` (user ${userId})`}`,
      `IP (truncated): ${truncateIp(rawIp) ?? '(none)'}`,
      '',
      'Explanation:',
      reportBody,
      '',
      'Triage at: /admin/abuse-reports'
    ].join('\n'),
    metadata: { reportId, category, docId: docId ?? '', anonymous: userId === null }
  })

  return { ok: true, reportId }
})
