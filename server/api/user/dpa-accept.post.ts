import { applyDpaAcceptance } from '../../repos/userPolicies'
import { appendAuditEvent } from '../../repos/audit'
import { AUDIT_POLICY_ACCEPTED } from '../../legal/auditActions'
import {
  AUTHORITATIVE_LOCALE,
  DPA_VERSION,
  LEGAL_DOCUMENT_LOCALES
} from '~~/shared/legal/versions'
import { acceptDpaBody } from '~~/shared/api/account'

// DPA acceptance recording. Hit by the workspace-creation flow:
// when a user without DPA acceptance tries to create their first
// workspace, the client shows the DPA modal first; on confirm
// this endpoint records the acceptance, then the workspace POST
// fires for real.
//
// Like the onboarding-accept endpoint, this is version-aware: the
// client must send the version it read so a stale prompt racing a
// version bump rejects with 409 + re-prompts.

export default defineApiHandler({
  access: allow.user(),
  body: acceptDpaBody,
  handler: async ({ event, user, body }) => {
    if (body.dpaVersion !== DPA_VERSION) {
      throw apiError('dpa/version-stale', { currentVersion: DPA_VERSION })
    }

    const locale = LEGAL_DOCUMENT_LOCALES.find(l => l === body.locale) ?? AUTHORITATIVE_LOCALE

    await applyDpaAcceptance({
      userId: user.id,
      dpaVersion: body.dpaVersion,
      locale
    })

    const ip = getClientIp(event)

    await appendAuditEvent({
      actorUserId: user.id,
      actorIp: ip,
      scope: 'user',
      scopeId: String(user.id),
      action: AUDIT_POLICY_ACCEPTED,
      metadata: {
        document: 'dpa',
        version: body.dpaVersion,
        locale
      }
    })

    return { ok: true }
  }
})
