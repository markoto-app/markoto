import { describe, expect, it } from 'vitest'
import { bool, bytes, csv, email, EnvValueError, hostname, int, limitOrUnlimited, oneOf, port, positiveNumber, secret, url } from '../../../shared/env/coerce'

// The shared parsers every registry variable is declared with. One
// dialect per kind: what a boolean, a URL or a byte count looks like is
// the same for every variable of every process.

describe('bool', () => {
  it('accepts one dialect, any case', () => {
    for (const raw of ['1', 'true', 'TRUE', 'yes', 'On']) expect(bool.parse(raw), raw).toBe(true)
    for (const raw of ['0', 'false', 'False', 'no', 'OFF']) expect(bool.parse(raw), raw).toBe(false)
  })

  it('refuses anything else instead of guessing', () => {
    for (const raw of ['enabled', 'y', '2', 'flase']) expect(() => bool.parse(raw), raw).toThrow(EnvValueError)
  })
})

describe('numbers', () => {
  it('int checks digits and range', () => {
    expect(int({ min: 0 }).parse('0')).toBe(0)
    expect(() => int({ min: 0 }).parse('-1')).toThrow('expected an integer ≥ 0')
    expect(() => int().parse('1.5')).toThrow(EnvValueError)
    expect(() => int().parse('12abc')).toThrow(EnvValueError)
    expect(() => int({ min: 1, max: 2000 }).parse('3072')).toThrow('integer 1–2000')
  })

  it('port, bytes and positive numbers name what they expect', () => {
    expect(port.parse('4001')).toBe(4001)
    expect(() => port.parse('70000')).toThrow(EnvValueError)
    expect(bytes.parse('16777216')).toBe(16777216)
    expect(() => bytes.parse('16MiB')).toThrow('expected bytes (integer ≥ 1)')
    expect(positiveNumber.parse('0.5')).toBe(0.5)
    for (const raw of ['0', '-5', 'abc', 'Infinity']) expect(() => positiveNumber.parse(raw), raw).toThrow('expected a number > 0')
  })

  it('limitOrUnlimited adds the word `unlimited` (→ null)', () => {
    const t = limitOrUnlimited(positiveNumber)
    expect(t.parse('UNLIMITED')).toBeNull()
    expect(t.parse('3')).toBe(3)
    expect(() => t.parse('-1')).toThrow('a number > 0 or "unlimited"')
  })
})

describe('text', () => {
  it('url keeps the value as written and checks the scheme', () => {
    expect(url().parse('https://markoto.app/')).toBe('https://markoto.app/')
    expect(() => url().parse('ftp://example.com')).toThrow('http/https URL')
    expect(() => url().parse('not a url')).toThrow(EnvValueError)
    expect(url(['ws', 'wss']).parse('wss://sync.example.org')).toBe('wss://sync.example.org')
  })

  it('hostname, email, oneOf', () => {
    expect(hostname.parse('pages.example.org')).toBe('pages.example.org')
    expect(() => hostname.parse('https://pages.example.org')).toThrow(EnvValueError)
    expect(email.parse('ops@example.org')).toBe('ops@example.org')
    expect(() => email.parse('ops at example')).toThrow(EnvValueError)
    expect(oneOf(['resend', 'stub']).parse('STUB')).toBe('stub')
    expect(() => oneOf(['resend', 'stub']).parse('mailgun')).toThrow('one of resend, stub')
  })

  it('csv trims, drops empty entries and names the bad one', () => {
    expect(csv().parse(' a, ,b ')).toEqual(['a', 'b'])
    expect(() => csv(url()).parse('https://a.example, nope')).toThrow('entry 2: expected an absolute http/https URL')
  })

  it('secret checks the length and never echoes the value', () => {
    expect(secret(32).parse('x'.repeat(32))).toHaveLength(32)
    try {
      secret(32).parse('hunter2')
      expect.unreachable()
    } catch (e) {
      expect(String(e)).toContain('at least 32 characters (got 7)')
      expect(String(e)).not.toContain('hunter2')
    }
  })
})
