import { describe, it, expect } from 'vitest'
import jwt from 'jsonwebtoken'
import { matchesCurrentOrPrevious, verifyJwtWithRotation } from '../../shared/utils/secrets'

// Secret rotation helpers. Running in prod these gate the internal app↔sync
// HTTP boundary (INTERNAL_API_SECRET) and Y.js JWT verification. Any false
// positive here is a cross-service authz bypass, so every branch gets tested.

describe('matchesCurrentOrPrevious', () => {
  it('matches the current secret', () => {
    expect(matchesCurrentOrPrevious('abc', 'abc')).toBe(true)
  })

  it('rejects a wrong secret', () => {
    expect(matchesCurrentOrPrevious('wrong', 'abc')).toBe(false)
  })

  it('matches the previous secret during rotation', () => {
    expect(matchesCurrentOrPrevious('old', 'new', 'old')).toBe(true)
  })

  it('rejects when previous is null/undefined', () => {
    expect(matchesCurrentOrPrevious('old', 'new')).toBe(false)
    expect(matchesCurrentOrPrevious('old', 'new', null)).toBe(false)
    expect(matchesCurrentOrPrevious('old', 'new', undefined)).toBe(false)
  })

  it('rejects empty provided against non-empty current', () => {
    expect(matchesCurrentOrPrevious('', 'abc')).toBe(false)
  })

  it('does not match on length mismatch even when prefixes match', () => {
    // Guard against any implementation that compares byte-by-byte up to
    // the shorter length — that would leak length via timing.
    expect(matchesCurrentOrPrevious('abc', 'abcd')).toBe(false)
    expect(matchesCurrentOrPrevious('abcd', 'abc')).toBe(false)
  })

  it('rejects when neither current nor previous matches', () => {
    expect(matchesCurrentOrPrevious('x', 'y', 'z')).toBe(false)
  })
})

describe('verifyJwtWithRotation', () => {
  const CURRENT = 'current-secret-' + 'x'.repeat(64)
  const PREVIOUS = 'previous-secret-' + 'y'.repeat(64)

  it('verifies token signed with current secret', () => {
    const token = jwt.sign({ sub: 'alice' }, CURRENT)
    const payload = verifyJwtWithRotation<{ sub: string }>(token, CURRENT)
    expect(payload.sub).toBe('alice')
  })

  it('falls back to previous secret', () => {
    const token = jwt.sign({ sub: 'bob' }, PREVIOUS)
    const payload = verifyJwtWithRotation<{ sub: string }>(token, CURRENT, PREVIOUS)
    expect(payload.sub).toBe('bob')
  })

  it('rejects token signed with unknown secret', () => {
    const token = jwt.sign({ sub: 'eve' }, 'some-other-secret')
    expect(() => verifyJwtWithRotation(token, CURRENT, PREVIOUS)).toThrow()
  })

  it('rejects token signed with unknown secret when no previous configured', () => {
    const token = jwt.sign({ sub: 'eve' }, 'some-other-secret')
    expect(() => verifyJwtWithRotation(token, CURRENT)).toThrow()
  })

  it('does not silently swallow expired-token errors', () => {
    // An expired token is different from a wrong-secret token. We do NOT
    // want rotation to rescue an expired token — its expiry is the whole
    // point of issuing it short-lived.
    const token = jwt.sign({ sub: 'alice' }, CURRENT, { expiresIn: '-1s' })
    expect(() => verifyJwtWithRotation(token, CURRENT, PREVIOUS))
      .toThrow(jwt.TokenExpiredError)
  })

  it('throws on completely malformed token regardless of previous', () => {
    expect(() => verifyJwtWithRotation('not.a.jwt', CURRENT, PREVIOUS)).toThrow()
  })

  it('rotation path only swallows signature mismatch, not other errors', () => {
    // A token signed with PREVIOUS but already expired should still throw
    // (expiry takes precedence over the rotation fallback path).
    const token = jwt.sign({ sub: 'alice' }, PREVIOUS, { expiresIn: '-1s' })
    expect(() => verifyJwtWithRotation(token, CURRENT, PREVIOUS)).toThrow()
  })
})
