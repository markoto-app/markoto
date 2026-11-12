import { claimAbuseReportTransition, getAbuseReport } from '../../../repos/abuseReports'
import { appendAuditEvent } from '../../../repos/audit'
import {
  AUDIT_ABUSE_ACKNOWLEDGED,
  AUDIT_ABUSE_ACTIONED,
  AUDIT_ABUSE_DISMISSED
} from '../../../legal/auditActions'
import {
  DECISION_EXPLANATION_MAX,
  DECISION_EXPLANATION_MIN,
  isModerationAction,
  isModerationRule,
  type ModerationAction,
  type ModerationRule
} from '~~/shared/config/moderation'
import { applyModerationDecision } from '../../../utils/privacy/moderationDecision'
import { updateAbuseReportBody, updateAbuseReportParams } from '~~/shared/api/legal'

// Admin status transitions for abuse reports:
//   open -> acknowledged | actioned | dismissed
//   acknowledged -> actioned | dismissed
// Backwards transitions are not allowed; a closed report stays closed.
//
// Closing a report needs a decision (`decision: {action, rule,
// explanation}`):
//   actioned  → action `content_removed` (doc deleted) or
//               `access_restricted` (doc set to private), a rule from
//               shared/config/moderation.ts and an explanation. The
//               document owner gets a statement of reasons (DSA Art.17);
//               for an anonymous doc we record that none could be sent.
//   dismissed → action `no_action` (implied) + explanation.
// Either way the reporter gets the decision (Art.16(5)). Every notice is
// recorded in `moderation_notices` (utils/moderationDecision.ts).
// `notes` stay internal and are never sent.

type Status = 'acknowledged' | 'actioned' | 'dismissed'

const ACTION_AUDIT: Record<Status, typeof AUDIT_ABUSE_ACKNOWLEDGED | typeof AUDIT_ABUSE_ACTIONED | typeof AUDIT_ABUSE_DISMISSED> = {
  acknowledged: AUDIT_ABUSE_ACKNOWLEDGED,
  actioned: AUDIT_ABUSE_ACTIONED,
  dismissed: AUDIT_ABUSE_DISMISSED
}

interface Decision {
  action: ModerationAction
  rule: ModerationRule | null
  explanation: string
}

function parseDecision(status: Status, raw: { action?: unknown, rule?: unknown, explanation?: unknown } | null | undefined): Decision | null {
  if (status === 'acknowledged') return null
  const explanation = typeof raw?.explanation === 'string' ? raw.explanation.trim() : ''
  if (explanation.length < DECISION_EXPLANATION_MIN || explanation.length > DECISION_EXPLANATION_MAX) {
    throw apiError('abuse/decision-explanation', { min: DECISION_EXPLANATION_MIN, max: DECISION_EXPLANATION_MAX })
  }
  const rule = raw?.rule
  if (status === 'dismissed') {
    return { action: 'no_action', rule: isModerationRule(rule) ? rule : null, explanation }
  }
  const action = raw?.action
  if (!isModerationAction(action) || action === 'no_action') {
    throw apiError('abuse/decision-action')
  }
  if (!isModerationRule(rule)) {
    throw apiError('abuse/decision-rule')
  }
  return { action, rule, explanation }
}

export default defineApiHandler({
  access: allow.admin(),
  params: updateAbuseReportParams,
  body: updateAbuseReportBody,
  handler: async ({ event, adminActor, params: { reportId }, body }) => {
    const status = body.status
    const decision = parseDecision(status, body.decision)
    const notes = typeof body.notes === 'string' ? body.notes.trim().slice(0, 5000) : null

    // Re-read for the existing notes + status (audit `before` payload and
    // transition validation).
    const existing = await getAbuseReport(adminActor, reportId)
    if (!existing) throw apiError('abuse/report-not-found')
    if (existing.status === 'actioned' || existing.status === 'dismissed') {
      throw apiError('abuse/already-closed', { status: existing.status })
    }

    // Claim the transition atomically (status unchanged since the read), so
    // two moderators can't both act, and both email, on one report.
    if (!(await claimAbuseReportTransition(adminActor, reportId, existing, { status, notes, decision }))) {
      throw apiError('abuse/conflict')
    }

    const ip = getClientIp(event)
    const outcome = decision
      ? await applyModerationDecision({ report: existing, decision, admin: adminActor, adminIp: ip })
      : null

    await appendAuditEvent({
      by: adminActor,
      actorIp: ip,
      scope: 'system',
      scopeId: reportId,
      action: ACTION_AUDIT[status],
      before: { status: existing.status, notes: existing.notes },
      after: { status, notes: notes ?? existing.notes },
      metadata: {
        reportId,
        category: existing.category,
        docId: existing.docId,
        ...(decision ? { decisionAction: decision.action, decisionRule: decision.rule ?? '' } : {}),
        ...(outcome ? { contentEffect: outcome.contentEffect, reporterNotice: outcome.reporterNotice, ownerNotice: outcome.ownerNotice ?? '' } : {})
      }
    })

    return { ok: true, ...(outcome ? { outcome } : {}) }
  }
})
