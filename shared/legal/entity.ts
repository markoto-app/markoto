// Legal entity facts substituted into the public legal documents at
// render time. The markdown sources at `content/legal/*/{locale}.md`
// reference these via `{{controllerName}}` / `{{controllerAddress}}` /
// `{{privacyContactEmail}}` / `{{abuseContactEmail}}` /
// `{{governingLaw}}`. The server-side renderer performs the
// substitution on every request so editing this file is sufficient
// to update every legal document at once.
//
// Each value can be overridden per-environment via `NUXT_LEGAL_*`
// env vars (read at request time, not at module load) so the prod
// deployment can pin its real legal entity without source edits.
//
// **Defaults are placeholders.** Keep them clearly distinguishable
// from real values so a misconfigured production deployment surfaces
// loudly rather than silently shipping a generic privacy policy.

export interface LegalEntity {
  // The legal entity operating markoto. Appears as "the controller"
  // in GDPR Article 4(7) terms.
  controllerName: string
  // Street address — required by ePrivacy / DSA / German Impressum.
  controllerAddress: string
  // Inbox for data-subject-rights requests + privacy questions.
  privacyContactEmail: string
  // Inbox for DSA Article 16 abuse / illegal-content reports.
  abuseContactEmail: string
  // Choice-of-law for the Terms of Service. e.g. "Swiss law" /
  // "the laws of Switzerland".
  governingLaw: string
}

export function resolveLegalEntity(): LegalEntity {
  return {
    controllerName: (process.env.NUXT_LEGAL_CONTROLLER_NAME?.trim())
      || 'Latent Labs GmbH',
    controllerAddress: (process.env.NUXT_LEGAL_CONTROLLER_ADDRESS?.trim())
      || 'Zurich, Switzerland',
    privacyContactEmail: (process.env.NUXT_LEGAL_PRIVACY_CONTACT_EMAIL?.trim())
      || 'privacy@markoto.app',
    abuseContactEmail: (process.env.NUXT_LEGAL_ABUSE_CONTACT_EMAIL?.trim())
      || 'abuse@markoto.app',
    governingLaw: (process.env.NUXT_LEGAL_GOVERNING_LAW?.trim())
      || 'Swiss law'
  }
}
