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
// **The defaults are the hosted markoto.app operator's company
// identity** (LatentSpace Labs GmbH: name, register numbers, role
// mailboxes). No natural person's name and no street address is a code
// default: `controllerAddress` and `representedBy` have none, and
// `legalEntityErrors` makes boot fail while the legal surfaces are on
// and either is unset. The defaults only ever surface while the legal
// surfaces are ON
// (`NUXT_LEGAL_SURFACES_ENABLED`, see `shared/config/instance.ts`) —
// the hosted SaaS. A self-hosted instance runs with them OFF by default
// and never presents LatentSpace Labs as its operator; a self-hoster who
// switches them on must set every `NUXT_LEGAL_*` value (and adapt
// `content/legal/`) — see docs/SELF-HOSTING.md#legal-pages.

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

type Env = Record<string, string | undefined>

export function resolveLegalEntity(env: Env = process.env): LegalEntity {
  return {
    controllerName: (env.NUXT_LEGAL_CONTROLLER_NAME?.trim())
      || 'LatentSpace Labs GmbH',
    controllerAddress: env.NUXT_LEGAL_CONTROLLER_ADDRESS?.trim() ?? '',
    privacyContactEmail: (env.NUXT_LEGAL_PRIVACY_CONTACT_EMAIL?.trim())
      || 'privacy@markoto.app',
    abuseContactEmail: (env.NUXT_LEGAL_ABUSE_CONTACT_EMAIL?.trim())
      || 'abuse@markoto.app',
    governingLaw: (env.NUXT_LEGAL_GOVERNING_LAW?.trim())
      || 'Swiss law',
    legalForm: (env.NUXT_LEGAL_LEGAL_FORM?.trim())
      || 'Gesellschaft mit beschränkter Haftung (GmbH)',
    registeredOffice: (env.NUXT_LEGAL_REGISTERED_OFFICE?.trim())
      || 'Zürich, Switzerland',
    representedBy: env.NUXT_LEGAL_REPRESENTED_BY?.trim() ?? '',
    uid: (env.NUXT_LEGAL_UID?.trim())
      || 'CHE-170.986.632',
    chId: (env.NUXT_LEGAL_CH_ID?.trim())
      || 'CH-020-4092420-2',
    ehraId: (env.NUXT_LEGAL_EHRA_ID?.trim())
      || '1753104'
  }
}

// The two facts that identify a person or a private residence cannot
// have a safe default, so an operator who turns the legal pages on must
// supply them. Returns boot-validation messages (empty when fine).
export function legalEntityErrors(env: Env = process.env): string[] {
  const entity = resolveLegalEntity(env)
  const errors: string[] = []
  if (!entity.controllerAddress) {
    errors.push('NUXT_LEGAL_CONTROLLER_ADDRESS is required when NUXT_LEGAL_SURFACES_ENABLED=true (the legal pages need a postal address)')
  }
  if (!entity.representedBy) {
    errors.push('NUXT_LEGAL_REPRESENTED_BY is required when NUXT_LEGAL_SURFACES_ENABLED=true (the Impressum names the authorised representative)')
  }
  return errors
}
