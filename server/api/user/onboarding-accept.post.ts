import { applyOnboardingAcceptance } from '../../repos/userPolicies'
import { appendAuditEvent } from '../../repos/audit'
import {
  AUDIT_ACCOUNT_AGE_CONFIRMED,
  AUDIT_POLICY_ACCEPTED
} from '../../legal/auditActions'
import {
  AUTHORITATIVE_LOCALE,
  LEGAL_DOCUMENT_LOCALES,
  PRIVACY_VERSION,
  TOS_VERSION
} from '~~/shared/legal/versions'
import { acceptOnboardingBody } from '~~/shared/api/account'

// Onboarding gate submission. Hit by the in-product modal that
// blocks the app on first login until the user (a) confirms they
// are at least 16 years old (GDPR Article 8 minimum digital age of
// consent), and (b) accepts the current Privacy Policy + Terms of
// Service. DPA acceptance is workspace-owner only, handled
// elsewhere when the user creates their first workspace.
//
// The request body MUST carry the version numbers the client read,
// so we can detect a stale modal racing a server-side version bump.
// If the client tells us "I accepted v1" but the current is v2, we
// reject with 409: the modal re-fetches the new versions and
// re-prompts.
//
// Locale is recorded so a future regulator query "which language
// did the user actually read the policy in?" has a definitive
// answer per acceptance.

export default defineApiHandler({
  access: allow.user(),
  body: acceptOnboardingBody,
  handler: async ({ event, user, body, self }) => {
    if (body.ageConfirmed !== true) throw apiError('onboarding/age-required')
    if (body.privacyVersion !== PRIVACY_VERSION) {
      throw apiError('onboarding/privacy-version-stale', { currentVersion: PRIVACY_VERSION })
    }
    if (body.tosVersion !== TOS_VERSION) {
      throw apiError('onboarding/tos-version-stale', { currentVersion: TOS_VERSION })
    }

    // Locale must be one of the locales we publish a translation in
    // (or English as the authoritative). Anything else collapses to
    // English so the audit trail stays readable.
    const locale = LEGAL_DOCUMENT_LOCALES.find(l => l === body.locale) ?? AUTHORITATIVE_LOCALE

    await applyOnboardingAcceptance(self, {
      privacyVersion: body.privacyVersion,
      tosVersion: body.tosVersion,
      locale
    })

    const ip = getClientIp(event)

    // Two audit rows: separable in queries by action. The age row
    // is dropped if the column was already non-null (idempotent
    // re-acceptance shouldn't fire the audit again). For the policies
    // we always record because each version-bump produces a fresh
    // acceptance event.
    await appendAuditEvent({
      by: self,
      actorIp: ip,
      scope: 'user',
      scopeId: String(user.id),
      action: AUDIT_ACCOUNT_AGE_CONFIRMED,
      metadata: { locale }
    })
    await appendAuditEvent({
      by: self,
      actorIp: ip,
      scope: 'user',
      scopeId: String(user.id),
      action: AUDIT_POLICY_ACCEPTED,
      metadata: {
        document: 'privacy',
        version: body.privacyVersion,
        locale
      }
    })
    await appendAuditEvent({
      by: self,
      actorIp: ip,
      scope: 'user',
      scopeId: String(user.id),
      action: AUDIT_POLICY_ACCEPTED,
      metadata: {
        document: 'tos',
        version: body.tosVersion,
        locale
      }
    })

    return { ok: true }
  }
})
