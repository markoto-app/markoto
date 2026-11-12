import { docIdForPublishedUrl } from '../utils/publish/takeDown'
import { createHash } from 'node:crypto'
import type { z } from 'zod'
import { nanoid } from 'nanoid'
import { insertAbuseReport } from '../repos/abuseReports'
import { truncateIp, appendAuditEvent } from '../repos/audit'
import { AUDIT_ABUSE_REPORTED } from '../legal/auditActions'
import { checkRateLimit } from '../utils/platform/rateLimit'
import { findUserById } from '../repos/users'
import { safeSendTransactionalEmail } from '../utils/email/sendEmail'
import { abuseNotificationRecipient } from '../utils/platform/instanceConfig'
import { anonGateEnabled, requireBotCheck } from '../utils/anonGate/gate'
import { buildReceiptNotice, deliverNotice } from '../utils/privacy/moderationNotices'
import { normaliseNoticeLocale } from '../utils/privacy/moderationNoticeCopy'
import { isValidEmailShape } from '../utils/workspaces/emailShape'
import {
  REPORTER_NAME_MAX,
  REPORT_BODY_MAX,
  REPORT_BODY_MIN,
  REPORT_URL_MAX,
  contactOptionalFor,
  docIdFromReportedLocation,
  isReportCategory,
  type ReportCategory
} from '~~/shared/config/moderation'
import { ANON_ABUSE_REPORT_LIMITS, USER_ABUSE_REPORT_LIMIT } from '~~/shared/config/anonLimits'
import { submitAbuseReportBody } from '~~/shared/api/legal'

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
// (self-hosted default) the form needs a sign-in. Signed-in reporters:
// 10/hour per user.
//
// On success: row + audit, a confirmation of receipt to the reporter
// (Art.16(4), recorded in `moderation_notices`) and a best-effort note to
// the operator's abuse inbox.

function trimmed(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

async function enforceRateLimits(userId: number | null, clientKey: string): Promise<void> {
  const rules = userId === null
    ? ANON_ABUSE_REPORT_LIMITS.map(r => ({ ...r, key: clientKey }))
    : [{ ...USER_ABUSE_REPORT_LIMIT, key: String(userId) }]
  for (const rule of rules) {
    if (!(await checkRateLimit(rule.namespace, rule.key, rule.max, rule.windowMs))) {
      throw apiError('abuse/rate-limited')
    }
  }
}

type ReportInput = NonNullable<z.output<typeof submitAbuseReportBody>>

/** Art.16(2)(a), (b), (d): the category, the location, the explanation and the good-faith statement. */
function readNotice(input: ReportInput): { category: ReportCategory, contentUrl: string, reportBody: string } {
  const category = input.category
  if (!isReportCategory(category)) throw apiError('abuse/invalid-category')
  const contentUrl = trimmed(input.contentUrl ?? input.docId, REPORT_URL_MAX)
  if (!contentUrl) throw apiError('abuse/url-required')
  const reportBody = typeof input.body === 'string' ? input.body.trim() : ''
  if (reportBody.length < REPORT_BODY_MIN) throw apiError('abuse/body-too-short')
  if (reportBody.length > REPORT_BODY_MAX) throw apiError('abuse/body-too-long')
  if (input.goodFaith !== true) throw apiError('abuse/good-faith-required')
  return { category, contentUrl, reportBody }
}

/** Art.16(2)(c): name + email, defaulting to a signed-in reporter's profile. */
function readReporterContact(
  input: ReportInput,
  category: ReportCategory,
  reporterUser: { name: string | null, email: string | null } | null
): { reporterName: string, reporterEmail: string } {
  const reporterName = trimmed(input.reporterName, REPORTER_NAME_MAX) || (reporterUser?.name?.trim() ?? '')
  const typedEmail = trimmed(input.reporterEmail, 320).toLowerCase()
  if (typedEmail && !isValidEmailShape(typedEmail)) throw apiError('abuse/invalid-email')
  const reporterEmail = typedEmail || (reporterUser?.email ?? '')
  if (!contactOptionalFor(category) && (!reporterName || !reporterEmail)) throw apiError('abuse/contact-required')
  return { reporterName, reporterEmail }
}

// Public with an optional session: an anonymous reporter is gated by the bot
// check below, so the rate limits depend on who is calling and stay inline.
export default defineApiHandler({
  access: allow.public('DSA Art.16 notices are open to everyone; anonymous reporters pass the ALTCHA bot check and per-client limits, signed-in ones the per-user limit', { session: 'optional' }),
  body: submitAbuseReportBody,
  handler: async ({ event, self, body }) => {
    const userId = self?.userId ?? null

    if (userId === null && !anonGateEnabled()) throw apiError('abuse/login-required')

    await enforceRateLimits(userId, getClientRateLimitKey(event))

    const input: NonNullable<typeof body> = body ?? {}
    const { category, contentUrl, reportBody } = readNotice(input)
    const reporterUser = userId === null ? null : await findUserById(userId)
    const { reporterName, reporterEmail } = readReporterContact(input, category, reporterUser)

    // Anonymous: bot check last (after the cheap validation, so a typo
    // doesn't burn the solution).
    if (userId === null) {
      await requireBotCheck(event, input.altcha, 'abuse-report')
    }

    // A published page is reported by its own address: /p/<slug> or a custom domain.
    const docId = docIdFromReportedLocation(contentUrl) ?? await docIdForPublishedUrl(contentUrl)
    const locale = normaliseNoticeLocale(input.locale)
    const rawIp = getClientIp(event)
    const userAgent = getRequestHeader(event, 'user-agent') ?? ''
    const userAgentHash = userAgent ? createHash('sha256').update(userAgent).digest('hex') : null

    const reportId = `rep-${nanoid(16)}`
    await insertAbuseReport(self, {
      reportId,
      docId,
      contentUrl,
      reporterEmail: reporterEmail || null,
      reporterName: reporterName || null,
      reporterLocale: locale,
      goodFaithConfirmedAt: new Date(),
      reporterIpTruncated: truncateIp(rawIp),
      reporterUserAgentHash: userAgentHash,
      category,
      body: reportBody
    })

    await appendAuditEvent({
      // The reporter when signed in; an anonymous reporter holds no proof.
      by: self,
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
  }
})
