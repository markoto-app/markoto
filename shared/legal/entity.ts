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
// the boot validation makes it fail while the legal surfaces are on
// and either is unset (shared/env/rules/legal.ts). The defaults only ever surface while the legal
// surfaces are ON
// (`NUXT_LEGAL_SURFACES_ENABLED`, see `shared/config/instance.ts`) —
// the hosted SaaS. A self-hosted instance runs with them OFF by default
// and never presents LatentSpace Labs as its operator; a self-hoster who
// switches them on must set every `NUXT_LEGAL_*` value (and adapt
// `content/legal/`) — see docs/SELF-HOSTING.md#legal-pages.

import { useEnv } from '../env/load'
import type { RawEnv } from '../env/define'

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

  // Provider-identification facts, rendered into the Impressum page.
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

/** The operator identity: configured `NUXT_LEGAL_*` values over the hosted operator's defaults. */
export function resolveLegalEntity(source?: RawEnv): LegalEntity {
  const { legal } = useEnv(source)
  return {
    controllerName: legal.controllerName || 'LatentSpace Labs GmbH',
    controllerAddress: legal.controllerAddress ?? '',
    privacyContactEmail: legal.privacyContactEmail || 'privacy@markoto.app',
    abuseContactEmail: legal.abuseContactEmail || 'abuse@markoto.app',
    governingLaw: legal.governingLaw || 'Swiss law',
    legalForm: legal.legalForm || 'Gesellschaft mit beschränkter Haftung (GmbH)',
    registeredOffice: legal.registeredOffice || 'Zürich, Switzerland',
    representedBy: legal.representedBy ?? '',
    uid: legal.uid || 'CHE-170.986.632',
    chId: legal.chId || 'CH-020-4092420-2',
    ehraId: legal.ehraId || '1753104'
  }
}
