import type { H3Event } from 'h3'
import { appendAuditEvent } from '../repos/audit'
import { AUDIT_POLICY_ACCEPTED } from '../legal/auditActions'
import { PAID_TERMS_VERSION } from '~~/shared/legal/versions'
import { PAID_TERMS_REQUIRED_CODE } from '~~/shared/config/pricing'

// Paid Plans Terms (WP6b, `content/legal/paid-terms/`). Every purchase —
// a plan checkout, an in-place plan switch, an AI-credit top-up — needs
// the buyer's explicit acceptance in the request (`acceptPaidTerms:
// true`, the ticked box beside the button). The box also carries the
// consumer's request to start at once (withdrawal, terms §6). Seat
// changes on a live subscription don't: they run under the terms
// accepted when it was bought.
//
// Acceptance is recorded per purchase in the audit log (`policy.accepted`,
// document `paid-terms`), the same record the onboarding + DPA acceptances
// use — not on the user row: one person can buy for several workspaces,
// and the record must name what was bought.

export interface PaidTermsPurchase {
  kind: 'plan' | 'topup'
  subject: { type: 'user' | 'workspace', id: string }
  /** Plan or credit pack bought. */
  item: string
}

/** 400 `billing/terms-required` unless the body carries `acceptPaidTerms: true`. */
export function requirePaidTermsAccepted(body: unknown): void {
  const accepted = typeof body === 'object' && body !== null && (body as Record<string, unknown>).acceptPaidTerms === true
  if (!accepted) {
    throw createError({
      statusCode: 400,
      message: 'Accept the Paid Plans Terms to continue.',
      data: { code: PAID_TERMS_REQUIRED_CODE, messageKey: 'billing.paidTerms.required' }
    })
  }
}

/** Record the acceptance (best-effort, like every audit write). */
export async function recordPaidTermsAcceptance(event: H3Event, userId: number, purchase: PaidTermsPurchase): Promise<void> {
  await appendAuditEvent({
    actorUserId: userId,
    actorIp: getClientIp(event),
    scope: purchase.subject.type === 'workspace' ? 'workspace' : 'user',
    scopeId: purchase.subject.id,
    action: AUDIT_POLICY_ACCEPTED,
    metadata: {
      document: 'paid-terms',
      version: PAID_TERMS_VERSION,
      purchase: purchase.kind,
      item: purchase.item
    }
  })
}
