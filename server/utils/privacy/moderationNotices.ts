import { nanoid } from 'nanoid'
import * as Sentry from '@sentry/nuxt'
import { moderationNotices } from '../../db/schema'
import { useDatabase } from '../platform/database'
import { safeSendTransactionalEmail, type TransactionalEmailKind } from '../email/sendEmail'
import { NOTICE_COPY, normaliseNoticeLocale, type NoticeLocale } from './moderationNoticeCopy'
import { isModerationRule, type ModerationAction } from '~~/shared/config/moderation'
import { appendAuditEvent } from '../../repos/audit'
import { AUDIT_ABUSE_NOTICE_RECORDED } from '../../legal/auditActions'
import { useLogger } from '../platform/logger'

const log = useLogger('moderation')

// Notices of the abuse pipeline: build the localised text, send it (if
// there is anyone to send it to) and record exactly what was produced in
// `moderation_notices` — including notices that could not be delivered.
//
// Pure builders (`build*`) are exported for unit tests; `deliverNotice`
// does the I/O.

export interface BuiltNotice {
  subject: string
  body: string
}

function lines(...parts: Array<string | null | false>): string {
  return parts.filter((p): p is string => typeof p === 'string').join('\n')
}

function ruleLabel(locale: NoticeLocale, rule: string | null): string {
  const copy = NOTICE_COPY[locale]
  return rule !== null && isModerationRule(rule) ? copy.rules[rule] : copy.rules.other_terms
}

export function buildReceiptNotice(rawLocale: unknown, input: { reportId: string, contentUrl: string | null }): BuiltNotice {
  const locale = normaliseNoticeLocale(rawLocale)
  const c = NOTICE_COPY[locale]
  return {
    subject: c.receiptSubject(input.reportId),
    body: lines(
      c.receiptBody,
      '',
      `${c.labels.reference}: ${input.reportId}`,
      input.contentUrl ? `${c.labels.reported}: ${input.contentUrl}` : null,
      '',
      c.closing
    )
  }
}

export interface DecisionInput {
  reportId: string
  contentUrl: string | null
  action: ModerationAction
  rule: string | null
  explanation: string
}

export function buildDecisionNotice(rawLocale: unknown, input: DecisionInput): BuiltNotice {
  const locale = normaliseNoticeLocale(rawLocale)
  const c = NOTICE_COPY[locale]
  return {
    subject: c.decisionSubject(input.reportId),
    body: lines(
      c.decisionIntro,
      '',
      `${c.labels.reference}: ${input.reportId}`,
      input.contentUrl ? `${c.labels.reported}: ${input.contentUrl}` : null,
      `${c.labels.decision}: ${c.actions[input.action]}`,
      input.action === 'no_action' ? null : `${c.labels.rule}: ${ruleLabel(locale, input.rule)}`,
      `${c.labels.reasons}: ${input.explanation}`,
      '',
      c.closing
    )
  }
}

export interface StatementInput {
  reportId: string
  documentUrl: string
  documentTitle: string
  action: ModerationAction
  rule: string | null
  explanation: string
  decidedAt: Date
  /** Where objections go (the abuse contact), or null when none is configured. */
  contact: string | null
}

/**
 * Statement of reasons (DSA Art.17(3)): what was done and where (a),
 * the facts relied on incl. that it was notice-based (b), whether
 * automated means were used (c), the ground — rule / illegality (d, e),
 * and the redress options (f).
 */
export function buildStatementOfReasons(rawLocale: unknown, input: StatementInput): BuiltNotice {
  const locale = normaliseNoticeLocale(rawLocale)
  const c = NOTICE_COPY[locale]
  return {
    subject: c.statementSubject,
    body: lines(
      c.statementIntro,
      '',
      `${c.labels.reference}: ${input.reportId}`,
      `${c.labels.document}: ${input.documentTitle} (${input.documentUrl})`,
      `${c.labels.decision}: ${c.actions[input.action]}`,
      `${c.labels.scope}: ${c.scopeText}`,
      `${c.labels.rule}: ${ruleLabel(locale, input.rule)}`,
      `${c.labels.reasons}: ${input.explanation}`,
      `${c.labels.basis}: ${c.basisText}`,
      `${c.labels.automation}: ${c.automationText}`,
      `${c.labels.decidedAt}: ${input.decidedAt.toISOString().slice(0, 10)}`,
      '',
      `${c.labels.objection}: ${input.contact ? c.objectionText(input.contact) : c.objectionNoContact}`,
      '',
      c.closing
    )
  }
}

export type NoticeKind = 'receipt' | 'decision' | 'statement_of_reasons'
export type NoticeStatus = 'sent' | 'not_delivered_no_contact' | 'failed'

const EMAIL_KIND: Record<NoticeKind, TransactionalEmailKind> = {
  receipt: 'abuse.report_received',
  decision: 'abuse.decision',
  statement_of_reasons: 'moderation.statement_of_reasons'
}

export interface DeliverNoticeInput {
  reportId: string
  kind: NoticeKind
  recipientRole: 'reporter' | 'owner'
  recipientUserId: number | null
  /** Email to send to; null = nobody to contact (recorded as not delivered). */
  to: string | null
  locale: unknown
  notice: BuiltNotice
}

/** Send (when possible) and record. Never throws; returns the recorded status. */
export async function deliverNotice(input: DeliverNoticeInput): Promise<NoticeStatus> {
  const locale = normaliseNoticeLocale(input.locale)
  let status: NoticeStatus = 'not_delivered_no_contact'
  if (input.to) {
    const result = await safeSendTransactionalEmail({
      kind: EMAIL_KIND[input.kind],
      to: input.to,
      locale,
      subject: input.notice.subject,
      body: input.notice.body,
      metadata: { reportId: input.reportId, kind: input.kind }
    })
    status = result?.delivered ? 'sent' : 'failed'
  }
  try {
    await useDatabase().insert(moderationNotices).values({
      noticeId: `ntc-${nanoid(16)}`,
      reportId: input.reportId,
      kind: input.kind,
      recipientRole: input.recipientRole,
      recipientUserId: input.recipientUserId,
      status,
      locale,
      subject: input.notice.subject,
      body: input.notice.body
    })
  } catch (e) {
    log.error('could not record notice', { err: e })
    Sentry.captureException(e, { tags: { component: 'moderation', event: 'notice_record_failed' } })
  }
  await appendAuditEvent({
    actorUserId: null,
    actorIp: null,
    scope: 'system',
    scopeId: input.reportId,
    action: AUDIT_ABUSE_NOTICE_RECORDED,
    metadata: { reportId: input.reportId, kind: input.kind, recipientRole: input.recipientRole, status }
  })
  return status
}
