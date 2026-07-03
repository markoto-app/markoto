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
  // ─── Provider-identification facts (Swiss UWG Art. 3(1)(s) / EU
  //     imprint requirements). Rendered into the Impressum page. ───
  // Legal form, e.g. "Gesellschaft mit beschränkter Haftung (GmbH)".
  legalForm: string
  // Registered office / Sitz.
  registeredOffice: string
  // Natural person(s) authorised to represent the company.
  representedBy: string
  // Swiss business identification number (UID / IDE).
  uid: string
  // Commercial-register (Handelsregister) identifiers.
  chId: string
  ehraId: string
}

export function resolveLegalEntity(): LegalEntity {
  return {
    controllerName: (process.env.NUXT_LEGAL_CONTROLLER_NAME?.trim())
      || 'LatentSpace Labs GmbH',
    controllerAddress: (process.env.NUXT_LEGAL_CONTROLLER_ADDRESS?.trim())
      || 'c/o Joel Barmettler, Hirschgartnerweg 18, 8057 Zürich, Switzerland',
    privacyContactEmail: (process.env.NUXT_LEGAL_PRIVACY_CONTACT_EMAIL?.trim())
      || 'privacy@markoto.app',
    abuseContactEmail: (process.env.NUXT_LEGAL_ABUSE_CONTACT_EMAIL?.trim())
      || 'abuse@markoto.app',
    governingLaw: (process.env.NUXT_LEGAL_GOVERNING_LAW?.trim())
      || 'Swiss law',
    legalForm: (process.env.NUXT_LEGAL_LEGAL_FORM?.trim())
      || 'Gesellschaft mit beschränkter Haftung (GmbH)',
    registeredOffice: (process.env.NUXT_LEGAL_REGISTERED_OFFICE?.trim())
      || 'Zürich, Switzerland',
    representedBy: (process.env.NUXT_LEGAL_REPRESENTED_BY?.trim())
      || 'Joel Barmettler',
    uid: (process.env.NUXT_LEGAL_UID?.trim())
      || 'CHE-170.986.632',
    chId: (process.env.NUXT_LEGAL_CH_ID?.trim())
      || 'CH-020-4092420-2',
    ehraId: (process.env.NUXT_LEGAL_EHRA_ID?.trim())
      || '1753104'
  }
}
