import { applyDpaAcceptance } from '../../repos/users'
import { appendAuditEvent } from '../../repos/audit'
import { AUDIT_POLICY_ACCEPTED } from '../../legal/auditActions'
import {
  AUTHORITATIVE_LOCALE,
  DPA_VERSION,
  LEGAL_DOCUMENT_LOCALES
} from '~~/shared/legal/versions'

// DPA acceptance recording. Hit by the workspace-creation flow:
// when a user without DPA acceptance tries to create their first
// workspace, the client shows the DPA modal first; on confirm
// this endpoint records the acceptance, then the workspace POST
// fires for real.
//
// Like the onboarding-accept endpoint, this is version-aware: the
// client must send the version it read so a stale prompt racing a
// version bump rejects with 409 + re-prompts.

interface RequestBody {
  dpaVersion: number
  locale: string
}

export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const body = await readBody<RequestBody>(event)

  if (!Number.isInteger(body?.dpaVersion)) {
    throw createError({ statusCode: 400, message: 'Invalid version' })
  }
  if (body.dpaVersion !== DPA_VERSION) {
    throw createError({
      statusCode: 409,
      message: `Data Processing Addendum has changed since you opened this prompt (you accepted v${body.dpaVersion}, current is v${DPA_VERSION}).`,
      data: { code: 'dpa/version-stale', currentVersion: DPA_VERSION }
    })
  }

  const locale = LEGAL_DOCUMENT_LOCALES.includes(
    body.locale as (typeof LEGAL_DOCUMENT_LOCALES)[number]
  )
    ? body.locale
    : AUTHORITATIVE_LOCALE

  await applyDpaAcceptance({
    userId: session.user.id,
    dpaVersion: body.dpaVersion,
    locale
  })

  const ip = getClientIp(event)

  await appendAuditEvent({
    actorUserId: session.user.id,
    actorIp: ip,
    scope: 'user',
    scopeId: String(session.user.id),
    action: AUDIT_POLICY_ACCEPTED,
    metadata: {
      document: 'dpa',
      version: body.dpaVersion,
      locale
    }
  })

  return { ok: true }
})
