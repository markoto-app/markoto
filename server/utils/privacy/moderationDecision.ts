import * as Sentry from '@sentry/nuxt'
import type { AbuseReportRow } from '../../repos/abuseReports'
import { getDoc, setModerationRestriction } from '../../repos/documents'
import { findUserById } from '../../repos/users'
import { appendAuditEvent } from '../../repos/audit'
import { deleteDocument } from '../documents/documentLifecycle'
import { AUDIT_DOC_UNPUBLISHED } from '../../legal/auditActions'
import { takeDownPublishedPage } from '../publish/takeDown'
import { deleteSharesForDoc } from '../../repos/documentShares'
import { notifySyncKickUser, notifySyncReauthDocument } from '../documents/syncNotify'
import { emailLinkBaseUrl } from '../platform/siteUrl'
import { abuseNotificationRecipient } from '../platform/instanceConfig'
import { buildDecisionNotice, buildStatementOfReasons, deliverNotice, type NoticeStatus } from './moderationNotices'
import { actionRestrictsContent, type ModerationAction, type ModerationRule } from '~~/shared/config/moderation'
import { useEnv } from '~~/shared/env/load'
import type { AuditDocSnapshot } from '../../repos/audit'
import type { AdminActor, DocAccess } from '../../repos/proofs'

// Carries out a moderator's decision on an abuse report:
//   1. snapshot the reported document (owner, title) BEFORE touching it,
//   2. apply the action to the content (delete / restrict: private, and
//      kept so until an admin lifts it),
//   3. statement of reasons to the owner (DSA Art.17) when the content
//      was removed or restricted, or a recorded "could not be delivered"
//      for an anonymous document (no owner to contact),
//   4. decision notice to the reporter (Art.16(5)).
// Every notice lands in `moderation_notices`. Called by
// PATCH /api/admin/abuse-reports/:reportId after the status transition
// was claimed, so it runs once per report.

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
  const base = emailLinkBaseUrl(useEnv().core.siteUrl)
  return base ? `${base}/d/${docId}` : (fallback ?? `/d/${docId}`)
}

async function applyToContent(
  doc: DocAccess<'manage' | 'delete'>,
  action: ModerationAction,
  meta: { reportId: string, admin: AdminActor, adminIp: string | null, before: AuditDocSnapshot }
): Promise<ContentEffect> {
  const docId = doc.docId
  if (action === 'content_removed') {
    await deleteDocument(doc)
    await appendAuditEvent({
      by: meta.admin,
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
    // Private, no password, no guest shares, and marked, so the owner
    // can't widen it again (utils/moderationRestriction.ts); only an
    // admin lifts it (DELETE /api/admin/documents/:docId/moderation-restriction).
    await setModerationRestriction(doc, { reportId: meta.reportId })
    // Guests reach a document through their share whatever its access
    // mode; close their open editors too.
    const unsharedGuestIds = await deleteSharesForDoc(doc)
    for (const guestId of unsharedGuestIds) notifySyncKickUser(guestId, [docId])
    // Everyone else who had it open through the link (or a password)
    // re-authenticates against the now private document.
    notifySyncReauthDocument(docId)
    // The web page is a separate public copy: restricting the document
    // takes it down too. (Removal deletes it with the document.)
    const page = await takeDownPublishedPage(doc)
    if (page) {
      await appendAuditEvent({
        by: meta.admin,
        actorIp: meta.adminIp,
        scope: 'doc',
        scopeId: docId,
        action: AUDIT_DOC_UNPUBLISHED,
        metadata: { pageId: page.id, reason: 'moderation', reportId: meta.reportId }
      })
    }
    await appendAuditEvent({
      by: meta.admin,
      actorIp: meta.adminIp,
      scope: 'doc',
      scopeId: docId,
      action: 'doc.access_mode_changed',
      before: { accessMode: meta.before.accessMode },
      after: { accessMode: 'private', moderationRestricted: true },
      metadata: { reason: 'moderation', reportId: meta.reportId, ...(unsharedGuestIds.length > 0 ? { guestSharesRemoved: unsharedGuestIds.length } : {}) }
    })
    return 'restricted'
  }
  return 'none'
}

export async function applyModerationDecision(input: {
  report: AbuseReportRow
  decision: ModerationDecision
  /** The deciding instance admin: the content change and its audit rows are theirs. */
  admin: AdminActor
  adminIp: string | null
}): Promise<ModerationOutcome> {
  const { report, decision } = input
  const decidedAt = new Date()
  const restricts = actionRestrictsContent(decision.action)
  const access = report.docId ? input.admin.doc(report.docId) : null
  const doc = access ? await getDoc(access) : null

  let contentEffect: ContentEffect = restricts ? 'not_found' : 'none'
  if (restricts && doc && access) {
    try {
      contentEffect = await applyToContent(access, decision.action, {
        reportId: report.reportId,
        admin: input.admin,
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
    const owner = doc?.ownerId ? await findUserById(input.admin.user(doc.ownerId)) : null
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
    // Anonymous doc (or one we could not find): no owner to contact,
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
