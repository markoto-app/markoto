// Unit tests for renderTokens.ts — the JWT mint/verify pair used by the
// renderer container to authenticate to the internal print page.
//
// What we verify:
//   - mint → verify roundtrip with matching docId returns the payload
//   - mismatched docId is rejected (cross-doc replay defence)
//   - scope mismatch is rejected (one secret could in principle be reused)
//   - expired token is rejected (default jsonwebtoken `exp` enforcement)
//   - rotation: a token signed with the previous secret still verifies
//
// Mocks: useRuntimeConfig() — renderTokens reads `internalApiSecret` /
// `internalApiSecretPrevious` straight off it.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import jwt from 'jsonwebtoken'
import { mintRenderToken, verifyRenderToken } from '../../../server/utils/rendering/renderTokens'

const CURRENT_SECRET = 'a'.repeat(64)
const PREVIOUS_SECRET = 'b'.repeat(64)

// useRuntimeConfig is only called at function-call time inside the SUT,
// so the global stub can be installed after the import.
vi.stubGlobal('useRuntimeConfig', () => ({
  internalApiSecret: CURRENT_SECRET,
  internalApiSecretPrevious: PREVIOUS_SECRET
}))

describe('renderTokens', () => {
  beforeEach(() => {
    vi.useRealTimers()
  })

  it('mint → verify roundtrips for matching docId', () => {
    const token = mintRenderToken('DOC_ABC', 42)
    const payload = verifyRenderToken(token, 'DOC_ABC')
    expect(payload).not.toBeNull()
    expect(payload?.docId).toBe('DOC_ABC')
    expect(payload?.snapshotId).toBe(42)
    expect(payload?.scope).toBe('render')
  })

  it('rejects token presented under a different docId (cross-doc replay)', () => {
    const token = mintRenderToken('DOC_A', 1)
    expect(verifyRenderToken(token, 'DOC_B')).toBeNull()
  })

  it('rejects a non-render-scoped JWT signed with the same secret', () => {
    // Hand-craft a token with a different scope to simulate reuse of the
    // shared internal secret for some other purpose.
    const evil = jwt.sign(
      { docId: 'DOC_A', snapshotId: 1, scope: 'kick-user' },
      CURRENT_SECRET,
      { expiresIn: 60 }
    )
    expect(verifyRenderToken(evil, 'DOC_A')).toBeNull()
  })

  it('rejects expired tokens', () => {
    // Sign with a negative TTL so jsonwebtoken treats it as already expired.
    const stale = jwt.sign(
      { docId: 'DOC_A', snapshotId: 1, scope: 'render' },
      CURRENT_SECRET,
      { expiresIn: -1 }
    )
    expect(verifyRenderToken(stale, 'DOC_A')).toBeNull()
  })

  it('rejects tokens signed with an unknown secret', () => {
    const wrongSecret = jwt.sign(
      { docId: 'DOC_A', snapshotId: 1, scope: 'render' },
      'an-unrelated-secret',
      { expiresIn: 60 }
    )
    expect(verifyRenderToken(wrongSecret, 'DOC_A')).toBeNull()
  })

  it('accepts tokens signed with the previous secret during rotation', () => {
    const token = jwt.sign(
      { docId: 'DOC_A', snapshotId: 7, scope: 'render' },
      PREVIOUS_SECRET,
      { expiresIn: 60 }
    )
    const payload = verifyRenderToken(token, 'DOC_A')
    expect(payload).not.toBeNull()
    expect(payload?.snapshotId).toBe(7)
  })

  it('returns null on garbage tokens without throwing', () => {
    expect(verifyRenderToken('not.a.jwt', 'DOC_A')).toBeNull()
    expect(verifyRenderToken('', 'DOC_A')).toBeNull()
  })
})
