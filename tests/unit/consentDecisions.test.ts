import { describe, expect, it } from 'vitest'
import { MAX_CONSENT_DECISIONS_IN, normaliseConsentDecisions } from '../../server/utils/consentDecisions'

// POST /api/consent is public and append-only: one submission must not be
// able to write more than one row per purpose.

describe('normaliseConsentDecisions', () => {
  it('passes a normal banner submission through', () => {
    expect(normaliseConsentDecisions([
      { purpose: 'essential', granted: true },
      { purpose: 'analytics', granted: false },
      { purpose: 'session_replay', granted: false }
    ])).toEqual([
      { purpose: 'essential', granted: true },
      { purpose: 'analytics', granted: false },
      { purpose: 'session_replay', granted: false }
    ])
  })

  it('keeps at most one decision per purpose (last one wins)', () => {
    const repeated = Array.from({ length: MAX_CONSENT_DECISIONS_IN }, (_, i) => ({ purpose: 'analytics', granted: i % 2 === 0 }))
    const result = normaliseConsentDecisions(repeated)
    expect(result).toHaveLength(1)
    expect(result?.[0]).toEqual({ purpose: 'analytics', granted: false })
  })

  it('drops unknown purposes and non-boolean values', () => {
    expect(normaliseConsentDecisions([
      { purpose: 'tracking', granted: true },
      { purpose: 'analytics', granted: 'yes' },
      null,
      'essential',
      { purpose: 'essential', granted: true }
    ])).toEqual([{ purpose: 'essential', granted: true }])
  })

  it('refuses empty, non-array and oversized payloads', () => {
    expect(normaliseConsentDecisions([])).toBeNull()
    expect(normaliseConsentDecisions(undefined)).toBeNull()
    expect(normaliseConsentDecisions({ purpose: 'essential', granted: true })).toBeNull()
    const huge = Array.from({ length: MAX_CONSENT_DECISIONS_IN + 1 }, () => ({ purpose: 'essential', granted: true }))
    expect(normaliseConsentDecisions(huge)).toBeNull()
  })
})
