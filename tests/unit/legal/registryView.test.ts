import { describe, it, expect } from 'vitest'
import {
  renderProcessingPurposesMarkdown,
  visibleProcessingPurposes,
  visibleSubProcessors
} from '../../../server/legal/registryView'
import { PROCESSING_PURPOSES } from '../../../server/legal/lawfulBasis'
import { SUB_PROCESSORS } from '../../../server/legal/subProcessors'

describe('registry views', () => {
  it('billing on shows the full registries', () => {
    expect(visibleSubProcessors(true)).toEqual(SUB_PROCESSORS)
    expect(visibleProcessingPurposes(true)).toEqual(PROCESSING_PURPOSES)
  })

  it('billing off hides Stripe and the billing purpose, nothing else', () => {
    expect(visibleSubProcessors(false).map(s => s.id)).not.toContain('stripe')
    expect(visibleSubProcessors(false)).toHaveLength(SUB_PROCESSORS.length - 1)
    expect(visibleProcessingPurposes(false).map(p => p.id)).not.toContain('billing')
    expect(visibleProcessingPurposes(false)).toHaveLength(PROCESSING_PURPOSES.length - 1)
  })

  it('renders one row per visible purpose with a header', () => {
    const lines = renderProcessingPurposesMarkdown(false).split('\n')
    expect(lines).toHaveLength(2 + visibleProcessingPurposes(false).length)
    expect(lines[0]).toContain('Purpose')
  })

  it('does not name Stripe in the table when billing is off, and does when on', () => {
    expect(renderProcessingPurposesMarkdown(false)).not.toContain('Stripe')
    expect(renderProcessingPurposesMarkdown(true)).toContain('Stripe')
  })

  it('the bring-your-own-key row lists our database but no AI provider as recipient', () => {
    const row = renderProcessingPurposesMarkdown(false).split('\n').find(l => l.includes('your own provider'))
    expect(row).toBeDefined()
    expect(row).toContain('OVHcloud (Managed PostgreSQL)')
    expect(row).not.toContain('Mistral')
  })
})
