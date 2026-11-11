import { describe, expect, it } from 'vitest'
import {
  CONSENT_PURPOSES,
  MAX_CONSENT_DECISIONS_IN,
  OPTIONAL_CONSENT_PURPOSES,
  normaliseConsentDecisions
} from '../../../server/utils/privacy/consentDecisions'

// POST /api/consent is public and append-only: one submission must not be
// able to write more than one row per purpose.

describe('consent purposes', () => {
  it('records only essential storage: no analytics or session replay is loaded anywhere', () => {
    expect(CONSENT_PURPOSES).toEqual(['essential'])
  })

  it('has nothing a visitor must be prompted for (so there is no cookie banner)', () => {
    expect(OPTIONAL_CONSENT_PURPOSES).toEqual([])
  })
})

describe('normaliseConsentDecisions', () => {
  it('passes an essential-only submission through', () => {
    expect(normaliseConsentDecisions([
      { purpose: 'essential', granted: true }
    ])).toEqual([
      { purpose: 'essential', granted: true }
    ])
  })

  it('keeps at most one decision per purpose (last one wins)', () => {
    const repeated = Array.from({ length: MAX_CONSENT_DECISIONS_IN }, (_, i) => ({ purpose: 'essential', granted: i % 2 === 0 }))
    const result = normaliseConsentDecisions(repeated)
    expect(result).toHaveLength(1)
    expect(result?.[0]).toEqual({ purpose: 'essential', granted: false })
  })

  it('drops retired and unknown purposes and non-boolean values', () => {
    expect(normaliseConsentDecisions([
      { purpose: 'analytics', granted: true },
      { purpose: 'session_replay', granted: true },
      { purpose: 'tracking', granted: true },
      { purpose: 'essential', granted: 'yes' },
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
