import { describe, it, expect } from 'vitest'
import { buildSpendBreakdown } from '../../../server/utils/litellm/spendBreakdown'
import { ALL_FEATURE_TAGS } from '../../../server/utils/litellm/featureTags'

// The admin spend table is built from spend-log groups where each logged call
// sits in exactly one group. Totals are the sum over calls, never over tags.

describe('buildSpendBreakdown', () => {
  it('totals equal the logged calls, with every canonical feature row present', () => {
    const out = buildSpendBreakdown([
      { feature_tag: 'feature:text-loop', spend: 0.02, requests: '10', total_tokens: '5000' },
      { feature_tag: 'feature:embeddings', spend: '0.0097', requests: '6', total_tokens: '1200' }
    ])
    expect(out.totalSpendUsd).toBeCloseTo(0.0297, 4)
    expect(out.totalRequests).toBe(16)
    expect(out.breakdown.map(r => r.tag)).toEqual(ALL_FEATURE_TAGS)
    expect(out.breakdown.find(r => r.tag === 'feature:text-loop')?.requests).toBe(10)
    expect(out.breakdown.some(r => r.tag === 'other')).toBe(false)
  })

  it('puts calls without a feature tag and unknown feature tags into "other"', () => {
    const out = buildSpendBreakdown([
      { feature_tag: 'feature:text-loop', spend: 0.03, requests: 3, total_tokens: 300 },
      { feature_tag: null, spend: 0.01, requests: 1, total_tokens: 100 },
      { feature_tag: 'feature:not-in-the-registry', spend: 0.01, requests: 1, total_tokens: 100 }
    ])
    expect(out.totalSpendUsd).toBeCloseTo(0.05, 4)
    expect(out.totalRequests).toBe(5)
    const other = out.breakdown.find(r => r.tag === 'other')
    expect(other).toMatchObject({ spendUsd: 0.02, requests: 2, totalTokens: 200, sharePct: 40 })
    expect(out.breakdown.find(r => r.tag === 'feature:text-loop')?.sharePct).toBe(60)
  })

  it('an empty window is all zeros with no "other" row', () => {
    const out = buildSpendBreakdown([])
    expect(out.totalSpendUsd).toBe(0)
    expect(out.totalRequests).toBe(0)
    expect(out.breakdown).toHaveLength(ALL_FEATURE_TAGS.length)
    expect(out.breakdown.every(r => r.spendUsd === 0 && r.sharePct === 0)).toBe(true)
  })
})
