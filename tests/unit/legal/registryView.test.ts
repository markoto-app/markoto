import { describe, it, expect } from 'vitest'
import {
  renderProcessingPurposesMarkdown,
  visibleProcessingPurposes,
  visibleSubProcessors
} from '../../../server/legal/registryView'
import { PROCESSING_PURPOSES } from '../../../server/legal/lawfulBasis'
import { SUB_PROCESSORS } from '../../../server/legal/subProcessors'

const ALL = { billing: true, analytics: true, adsConversions: true }
const OFF = { billing: false, analytics: false, adsConversions: false }
const HOSTED = { billing: false, analytics: true, adsConversions: true }

describe('registry views', () => {
  it('billing on shows the full registries', () => {
    expect(visibleSubProcessors(ALL)).toEqual(SUB_PROCESSORS)
    expect(visibleProcessingPurposes(ALL)).toEqual(PROCESSING_PURPOSES)
  })

  it('billing off hides Stripe and the billing purpose, nothing else', () => {
    expect(visibleSubProcessors(HOSTED).map(s => s.id)).not.toContain('stripe')
    expect(visibleSubProcessors(HOSTED)).toHaveLength(SUB_PROCESSORS.length - 1)
    expect(visibleProcessingPurposes(HOSTED).map(p => p.id)).not.toContain('billing')
    expect(visibleProcessingPurposes(HOSTED)).toHaveLength(PROCESSING_PURPOSES.length - 1)
  })

  it('analytics and ad conversions off hide their purposes and Google Ads', () => {
    expect(visibleSubProcessors(OFF).map(s => s.id)).not.toContain('google_ads')
    expect(visibleSubProcessors(HOSTED).map(s => s.id)).toContain('google_ads')
    const off = visibleProcessingPurposes(OFF).map(p => p.id)
    expect(off).not.toContain('web_analytics')
    expect(off).not.toContain('ad_conversion_measurement')
    expect(visibleProcessingPurposes({ ...OFF, analytics: true }).map(p => p.id)).toContain('web_analytics')
    expect(renderProcessingPurposesMarkdown(OFF)).not.toContain('Google Ads')
    expect(renderProcessingPurposesMarkdown(HOSTED)).toContain('Google Ireland Limited (Google Ads)')
  })

  it('renders one row per visible purpose with a header', () => {
    const lines = renderProcessingPurposesMarkdown(OFF).split('\n')
    expect(lines).toHaveLength(2 + visibleProcessingPurposes(OFF).length)
    expect(lines[0]).toContain('Purpose')
  })

  it('does not name Stripe in the table when billing is off, and does when on', () => {
    expect(renderProcessingPurposesMarkdown(OFF)).not.toContain('Stripe')
    expect(renderProcessingPurposesMarkdown(ALL)).toContain('Stripe')
  })

  it('the bring-your-own-key row lists our database but no AI provider as recipient', () => {
    const row = renderProcessingPurposesMarkdown(OFF).split('\n').find(l => l.includes('your own provider'))
    expect(row).toBeDefined()
    expect(row).toContain('OVHcloud (Managed PostgreSQL)')
    expect(row).not.toContain('Mistral')
  })
})
