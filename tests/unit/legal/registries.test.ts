import { describe, it, expect } from 'vitest'
import { SUB_PROCESSORS } from '../../../server/legal/subProcessors'
import { PROCESSING_PURPOSES } from '../../../server/legal/lawfulBasis'
import * as auditActions from '../../../server/legal/auditActions'

// Sanity tests for the legal registries. These are constants-only
// modules — no DB, no I/O — but they're load-bearing for the
// privacy disclosure and the audit log. A typo in a sub-processor
// id reference, or a duplicate id, would silently produce a
// broken privacy policy or a corrupt audit row. These tests pin
// the structural invariants.

describe('SUB_PROCESSORS', () => {
  it('has unique ids', () => {
    const ids = SUB_PROCESSORS.map(p => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('every entry has the required fields populated', () => {
    for (const sp of SUB_PROCESSORS) {
      expect(sp.id).toBeTruthy()
      expect(sp.name).toBeTruthy()
      expect(sp.purpose).toBeTruthy()
      expect(['eu', 'us', 'global']).toContain(sp.location)
      expect(['intra_eu', 'dpf', 'sccs', 'dpf_with_sccs_fallback'])
        .toContain(sp.transferMechanism)
      expect(typeof sp.dpfCertified).toBe('boolean')
      expect(sp.privacyPolicyUrl).toBeTruthy()
      // dpaUrl is nullable on purpose
    }
  })

  it('non-EU sub-processors declare a non-intra_eu transfer mechanism', () => {
    // Catches the inverse misconfiguration too — a sub-processor
    // marked `eu` shouldn't carry a DPF transfer mechanism.
    for (const sp of SUB_PROCESSORS) {
      if (sp.location === 'eu') {
        expect(sp.transferMechanism).toBe('intra_eu')
      } else {
        expect(sp.transferMechanism).not.toBe('intra_eu')
      }
    }
  })
})

describe('PROCESSING_PURPOSES', () => {
  it('has unique ids', () => {
    const ids = PROCESSING_PURPOSES.map(p => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('every sub-processor reference resolves in SUB_PROCESSORS', () => {
    const subProcessorIds = new Set(SUB_PROCESSORS.map(s => s.id))
    for (const purpose of PROCESSING_PURPOSES) {
      for (const ref of purpose.subProcessors) {
        expect(subProcessorIds.has(ref), `purpose ${purpose.id} references unknown sub-processor "${ref}"`).toBe(true)
      }
    }
  })

  it('every entry has a known lawful basis', () => {
    const validBases = ['contract', 'legal_obligation', 'legitimate_interest', 'consent']
    for (const purpose of PROCESSING_PURPOSES) {
      expect(validBases).toContain(purpose.basis)
    }
  })

  it('every retention is either a positive integer day-count or a known sentinel', () => {
    for (const purpose of PROCESSING_PURPOSES) {
      const r = purpose.retention
      const isInt = typeof r === 'number' && Number.isInteger(r) && r > 0
      const isSentinel = r === 'until_deletion' || r === 'legal_minimum'
      expect(isInt || isSentinel, `purpose ${purpose.id} has invalid retention: ${r}`).toBe(true)
    }
  })
})

describe('AUDIT action constants', () => {
  it('every exported AUDIT_* constant has a unique value', () => {
    const constants = Object.entries(auditActions)
      .filter(([k, v]) => k.startsWith('AUDIT_') && typeof v === 'string') as Array<[string, string]>
    const values = constants.map(([, v]) => v)
    expect(new Set(values).size, `duplicate audit-action values: ${values.join(', ')}`).toBe(values.length)
  })

  it('audit-action values are lowercase + dot-separated namespaces', () => {
    const constants = Object.entries(auditActions)
      .filter(([k, v]) => k.startsWith('AUDIT_') && typeof v === 'string') as Array<[string, string]>
    for (const [key, value] of constants) {
      // namespace.verb format. Allows multi-segment verbs like
      // 'account.delete_requested' but not uppercase or stray
      // chars (would corrupt admin queries).
      expect(value, `${key} = ${value} doesn't match namespace.verb format`)
        .toMatch(/^[a-z][a-z_]*(\.[a-z][a-z_]*)+$/)
    }
  })
})
