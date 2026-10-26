// Deployment-aware views over the legal registries.
//
// The registries (`lawfulBasis.ts`, `subProcessors.ts`) describe every
// processor and purpose the codebase CAN use. A deployment with billing
// off (self-hosted, or the free-only hosted SaaS) never calls Stripe, so
// listing Stripe as a recipient there would be a false disclosure. These
// helpers apply that one rule in one place; the sub-processor page and
// the privacy policy's register table both go through them.
//
// Pure: takes the billing flag as an argument so unit tests need no env.

import { PROCESSING_PURPOSES, type ProcessingPurpose } from './lawfulBasis'
import { SUB_PROCESSORS, type SubProcessor } from './subProcessors'

/** Sub-processors that are only engaged while billing is on. */
const BILLING_ONLY_SUB_PROCESSORS: ReadonlySet<string> = new Set(['stripe'])

/** Processing purposes that only exist while billing is on. */
const BILLING_ONLY_PURPOSES: ReadonlySet<string> = new Set(['billing'])

export function visibleSubProcessors(billingEnabled: boolean): readonly SubProcessor[] {
  if (billingEnabled) return SUB_PROCESSORS
  return SUB_PROCESSORS.filter(sp => !BILLING_ONLY_SUB_PROCESSORS.has(sp.id))
}

export function visibleProcessingPurposes(billingEnabled: boolean): readonly ProcessingPurpose[] {
  if (billingEnabled) return PROCESSING_PURPOSES
  return PROCESSING_PURPOSES.filter(p => !BILLING_ONLY_PURPOSES.has(p.id))
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
export function renderProcessingPurposesMarkdown(billingEnabled: boolean): string {
  const subProcessors = visibleSubProcessors(billingEnabled)
  const names = new Map(subProcessors.map(sp => [sp.id, sp.name]))
  const header = [
    '| Purpose | Lawful basis | Data categories | Retention | Recipients |',
    '| --- | --- | --- | --- | --- |'
  ]
  const rows = visibleProcessingPurposes(billingEnabled).map((p) => {
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
