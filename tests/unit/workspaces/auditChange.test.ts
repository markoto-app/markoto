import { describe, expect, it } from 'vitest'
import { auditChanges } from '../../../app/utils/workspace/auditChange'

// The one-line "what changed" of an audit log row.

describe('auditChanges', () => {
  it('lists the fields whose value differs', () => {
    expect(auditChanges({ plan: 'team', interval: 'month' }, { plan: 'business', interval: 'month' }))
      .toEqual([{ key: 'plan', from: 'team', to: 'business' }])
    expect(auditChanges({ seats: 3 }, { seats: 5 })).toEqual([{ key: 'seats', from: 3, to: 5 }])
    expect(auditChanges({ plan: 'team', interval: 'month' }, { plan: 'business', interval: 'year' })).toHaveLength(2)
  })

  it('treats a missing field as empty', () => {
    expect(auditChanges({ expiresAt: null }, { expiresAt: '2026-12-01T00:00:00.000Z', noDownload: true }))
      .toEqual([
        { key: 'expiresAt', from: null, to: '2026-12-01T00:00:00.000Z' },
        { key: 'noDownload', from: null, to: true }
      ])
  })

  it('is empty without a before / after pair', () => {
    expect(auditChanges(null, { role: 'editor' })).toEqual([])
    expect(auditChanges({ role: 'editor' }, null)).toEqual([])
    expect(auditChanges(undefined, undefined)).toEqual([])
    expect(auditChanges(['a'], ['b'])).toEqual([])
  })

  it('leaves out ids and nested values', () => {
    expect(auditChanges({ billingAdminId: 1, workspaceId: 'a', theme: { a: 1 } }, { billingAdminId: 2, workspaceId: 'b', theme: { a: 2 } })).toEqual([])
  })
})
