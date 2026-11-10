import * as Sentry from '@sentry/nuxt'
import type { abuseReports } from '../db/schema'
import { getDoc, updateDocMeta } from '../repos/documents'
import { findUserById } from '../repos/users'
import { appendAuditEvent } from '../repos/audit'
import { deleteDocument } from './documentLifecycle'
import { AUDIT_DOC_UNPUBLISHED } from '../legal/auditActions'
import { takeDownPublishedPage } from './publish/takeDown'
import { emailLinkBaseUrl } from './siteUrl'
import { abuseNotificationRecipient } from './instanceConfig'
import { buildDecisionNotice, buildStatementOfReasons, deliverNotice, type NoticeStatus } from './moderationNotices'
import { actionRestrictsContent, type ModerationAction, type ModerationRule } from '~~/shared/config/moderation'

// Carries out a moderator's decision on an abuse report:
//   1. snapshot the reported document (owner, title) BEFORE touching it,
//   2. apply the action to the content (delete / set private),
//   3. statement of reasons to the owner (DSA Art.17) when the content
//      was removed or restricted — or a recorded "could not be delivered"
//      for an anonymous document (no owner to contact),
//   4. decision notice to the reporter (Art.16(5)).
// Every notice lands in `moderation_notices`. Called by
// PATCH /api/admin/abuse-reports/:reportId after the status transition
// was claimed, so it runs once per report.

type AbuseReportRow = typeof abuseReports.$inferSelect

export interface ModerationDecision {
  action: ModerationAction
  rule: ModerationRule | null
  explanation: string
}

export type ContentEffect = 'removed' | 'restricted' | 'none' | 'not_found'

export interface ModerationOutcome {
  contentEffect: ContentEffect
  reporterNotice: NoticeStatus
  /** null = no statement owed (no action on the content). */
  ownerNotice: NoticeStatus | null
}

function documentUrl(docId: string, fallback: string | null): string {
  const base = emailLinkBaseUrl(useRuntimeConfig().siteUrl)
  return base ? `${base}/d/${docId}` : (fallback ?? `/d/${docId}`)
}

async function applyToContent(
  docId: string,
  action: ModerationAction,
  meta: { reportId: string, adminUserId: number, adminIp: string | null, before: Record<string, unknown> }
): Promise<ContentEffect> {
  if (action === 'content_removed') {
    await deleteDocument(docId)
    await appendAuditEvent({
      actorUserId: meta.adminUserId,
      actorIp: meta.adminIp,
      scope: 'doc',
      scopeId: docId,
      action: 'doc.deleted',
      before: meta.before,
      after: null,
      metadata: { reason: 'moderation', reportId: meta.reportId }
    })
    return 'removed'
  }
  if (action === 'access_restricted') {
    await updateDocMeta(docId, { accessMode: 'private' })
    // The web page is a separate public copy (WP13): restricting the
    // document takes it down too. (Removal deletes it with the document.)
    const page = await takeDownPublishedPage(docId)
    if (page) {
      await appendAuditEvent({
        actorUserId: meta.adminUserId,
        actorIp: meta.adminIp,
        scope: 'doc',
        scopeId: docId,
        action: AUDIT_DOC_UNPUBLISHED,
        metadata: { pageId: page.id, reason: 'moderation', reportId: meta.reportId }
      })
    }
    await appendAuditEvent({
      actorUserId: meta.adminUserId,
      actorIp: meta.adminIp,
      scope: 'doc',
      scopeId: docId,
      action: 'doc.access_mode_changed',
      before: { accessMode: meta.before.accessMode ?? null },
      after: { accessMode: 'private' },
      metadata: { reason: 'moderation', reportId: meta.reportId }
    })
    return 'restricted'
  }
  return 'none'
}

export async function applyModerationDecision(input: {
  report: AbuseReportRow
  decision: ModerationDecision
  adminUserId: number
  adminIp: string | null
}): Promise<ModerationOutcome> {
  const { report, decision } = input
  const decidedAt = new Date()
  const restricts = actionRestrictsContent(decision.action)
  const doc = report.docId ? await getDoc(report.docId) : null

  let contentEffect: ContentEffect = restricts ? 'not_found' : 'none'
  if (restricts && doc) {
    try {
      contentEffect = await applyToContent(doc.docId, decision.action, {
        reportId: report.reportId,
        adminUserId: input.adminUserId,
        adminIp: input.adminIp,
        before: { title: doc.title, accessMode: doc.accessMode, ownerId: doc.ownerId, workspaceId: doc.workspaceId }
      })
    } catch (e) {
      // The decision is recorded; the moderator sees the effect in the
      // response and can retry the content change by hand.
      Sentry.captureException(e, { tags: { component: 'moderation', event: 'apply_failed' } })
      contentEffect = 'not_found'
    }
  }

  let ownerNotice: NoticeStatus | null = null
  if (restricts) {
    const owner = doc?.ownerId ? await findUserById(doc.ownerId) : null
    const notice = buildStatementOfReasons(owner?.locale, {
      reportId: report.reportId,
      documentUrl: documentUrl(report.docId ?? '', report.contentUrl),
      documentTitle: doc?.title ?? '',
      action: decision.action,
      rule: decision.rule,
      explanation: decision.explanation,
      decidedAt,
      contact: abuseNotificationRecipient()
    })
    // Anonymous doc (or one we could not find): no owner to contact —
    // recorded as not delivered, with the text we would have sent.
    ownerNotice = await deliverNotice({
      reportId: report.reportId,
      kind: 'statement_of_reasons',
      recipientRole: 'owner',
      recipientUserId: owner?.id ?? null,
      to: owner?.email ?? null,
      locale: owner?.locale,
      notice
    })
  }

  const reporterNotice = await deliverNotice({
    reportId: report.reportId,
    kind: 'decision',
    recipientRole: 'reporter',
    recipientUserId: report.reporterUserId,
    to: report.reporterEmail,
    locale: report.reporterLocale,
    notice: buildDecisionNotice(report.reporterLocale, {
      reportId: report.reportId,
      contentUrl: report.contentUrl ?? report.docId,
      action: decision.action,
      rule: decision.rule,
      explanation: decision.explanation
    })
  })

  return { contentEffect, reporterNotice, ownerNotice }
}
