// Deployment-aware views over the legal registries.
//
// The registries (`lawfulBasis.ts`, `subProcessors.ts`) describe every
// processor and purpose the codebase CAN use. A deployment with billing
// off (self-hosted, or the free-only hosted SaaS) never calls Stripe, so
// listing Stripe as a recipient there would be a false disclosure; the
// same holds for page analytics and Google Ads conversions while they are
// off. These helpers apply those rules in one place; the sub-processor
// page and the privacy policy's register table both go through them.
//
// Pure: takes the flags as an argument so unit tests need no env.

import { PROCESSING_PURPOSES, type ProcessingPurpose } from './lawfulBasis'
import { SUB_PROCESSORS, type SubProcessor } from './subProcessors'

/** What the deployment runs, which decides what the registries show. */
export interface RegistryFlags {
  billing: boolean
  /** Cookieless page analytics (NUXT_PUBLIC_ANALYTICS_WEBSITE_ID set). */
  analytics: boolean
  /** Google Ads click-id conversions (NUXT_PUBLIC_ANALYTICS_ADS_CONVERSIONS). */
  adsConversions: boolean
}

/** Sub-processors / recipients that exist only under a flag. */
const GATED_SUB_PROCESSORS: Record<string, keyof RegistryFlags> = {
  stripe: 'billing',
  google_ads: 'adsConversions'
}

/** Processing purposes that exist only under a flag. */
const GATED_PURPOSES: Record<string, keyof RegistryFlags> = {
  billing: 'billing',
  web_analytics: 'analytics',
  acquisition_measurement: 'analytics',
  ad_conversion_measurement: 'adsConversions'
}

function shown(gate: keyof RegistryFlags | undefined, flags: RegistryFlags): boolean {
  return gate === undefined || flags[gate]
}

export function visibleSubProcessors(flags: RegistryFlags): readonly SubProcessor[] {
  return SUB_PROCESSORS.filter(sp => shown(GATED_SUB_PROCESSORS[sp.id], flags))
}

export function visibleProcessingPurposes(flags: RegistryFlags): readonly ProcessingPurpose[] {
  return PROCESSING_PURPOSES.filter(p => shown(GATED_PURPOSES[p.id], flags))
}

const BASIS_LABEL: Record<ProcessingPurpose['basis'], string> = {
  contract: 'Contract (Art. 6(1)(b))',
  legal_obligation: 'Legal obligation (Art. 6(1)(c))',
  legitimate_interest: 'Legitimate interest (Art. 6(1)(f))',
  consent: 'Consent (Art. 6(1)(a))'
}

function retentionLabel(retention: ProcessingPurpose['retention']): string {
  if (typeof retention === 'number') return `${retention} days`
  switch (retention) {
    case 'until_deletion': return 'Until you delete it or your account'
    case 'legal_minimum': return 'Legal minimum'
    case 'until_withdrawn': return 'Until you withdraw consent (see the policy text for the outer limit)'
  }
}

function humanise(id: string): string {
  return id.replaceAll('_', ' ')
}

function cell(text: string): string {
  return text.replaceAll('|', '\\|')
}

/**
 * Markdown table of every processing purpose for the privacy policy.
 * Substituted for `{{processingPurposesTable}}` by the legal renderer.
 * Content is the English registry text (the registry is not localised).
 */
export function renderProcessingPurposesMarkdown(flags: RegistryFlags): string {
  const subProcessors = visibleSubProcessors(flags)
  const names = new Map(subProcessors.map(sp => [sp.id, sp.name]))
  const header = [
    '| Purpose | Lawful basis | Data categories | Retention | Recipients |',
    '| --- | --- | --- | --- | --- |'
  ]
  const rows = visibleProcessingPurposes(flags).map((p) => {
    const recipients = p.subProcessors
      .map(id => names.get(id))
      .filter((n): n is string => n !== undefined)
    return '| ' + [
      p.label,
      BASIS_LABEL[p.basis],
      p.dataCategories.map(humanise).join(', '),
      retentionLabel(p.retention),
      recipients.length > 0 ? recipients.join(', ') : 'None (handled by us)'
    ].map(cell).join(' | ') + ' |'
  })
  return [...header, ...rows].join('\n')
}
