import { describe, it, expect } from 'vitest'
import { isValidEmailShape } from '../../server/utils/workspaces/emailShape'

// `isValidEmailShape` replaced the inline /^[^\s@]+@[^\s@]+\.[^\s@]+$/
// in the workspace member-invite endpoint (SonarQube S8786 — that
// regex backtracks super-linearly on crafted input). The function must
// keep the regex's exact accept/reject behaviour: this suite pins both
// the normal cases and the odd corners the old regex allowed.

const OLD_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

describe('isValidEmailShape', () => {
  it('accepts ordinary addresses', () => {
    expect(isValidEmailShape('joel@example.com')).toBe(true)
    expect(isValidEmailShape('a@b.c')).toBe(true)
    expect(isValidEmailShape('first.last+tag@sub.domain.co.uk')).toBe(true)
  })

  it('rejects missing / empty pieces', () => {
    expect(isValidEmailShape('')).toBe(false)
    expect(isValidEmailShape('plainaddress')).toBe(false)
    expect(isValidEmailShape('@example.com')).toBe(false) // empty local part
    expect(isValidEmailShape('user@')).toBe(false) // empty domain
    expect(isValidEmailShape('user@nodot')).toBe(false) // dot-less domain
  })

  it('rejects whitespace anywhere', () => {
    expect(isValidEmailShape('user name@example.com')).toBe(false)
    expect(isValidEmailShape('user@exa mple.com')).toBe(false)
    expect(isValidEmailShape(' user@example.com')).toBe(false)
    expect(isValidEmailShape('user@example.com\t')).toBe(false)
  })

  it('rejects multiple @ signs', () => {
    expect(isValidEmailShape('a@b@c.d')).toBe(false)
    expect(isValidEmailShape('a@@b.c')).toBe(false)
  })

  it('rejects a domain dot at the very start or very end when it is the only dot', () => {
    expect(isValidEmailShape('user@.com')).toBe(false)
    expect(isValidEmailShape('user@com.')).toBe(false)
  })

  it('matches the old regex verbatim across a corpus of corner cases', () => {
    // Includes inputs the old regex ACCEPTED despite looking odd
    // (dots inside the domain may neighbour other dots) — behaviour
    // is preserved, not tightened.
    const corpus = [
      'joel@example.com', 'a@b.c', 'a@b..c', 'a@.b.c', 'a@b.c.',
      'a@b.', 'a@.b', '.a@b.c', 'a.@b.c', 'a@b', '@b.c', 'a@',
      'a b@c.d', 'a@b c.d', 'a@@b.c', 'a@b@c.d', '', 'no-at-sign',
      'üser@bü.chø', 'a@-.-', 'a@...'
    ]
    for (const input of corpus) {
      expect(isValidEmailShape(input), JSON.stringify(input)).toBe(OLD_REGEX.test(input))
    }
  })

  it('stays fast on adversarial input (no catastrophic backtracking)', () => {
    // The old regex went quadratic on this shape; the scan must not.
    const evil = 'a@' + 'b.'.repeat(50_000) + '@'
    const started = performance.now()
    expect(isValidEmailShape(evil)).toBe(false)
    expect(performance.now() - started).toBeLessThan(200)
  })
})
