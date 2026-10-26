import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  WAITLIST_LOCALES,
  buildWaitlistConfirmEmail,
  generateWaitlistToken,
  hashWaitlistToken,
  isWaitlistOpen,
  normaliseWaitlistEmail,
  normaliseWaitlistLocale,
  parseWaitlistToken
} from '../../server/utils/waitlist'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('normaliseWaitlistEmail', () => {
  it('trims and lower-cases so re-signups are idempotent', () => {
    expect(normaliseWaitlistEmail('  Maya.Chen@Example.COM ')).toBe('maya.chen@example.com')
  })

  it('rejects non-strings, empty, malformed and over-long input', () => {
    expect(normaliseWaitlistEmail(undefined)).toBeNull()
    expect(normaliseWaitlistEmail(42)).toBeNull()
    expect(normaliseWaitlistEmail('   ')).toBeNull()
    expect(normaliseWaitlistEmail('not-an-email')).toBeNull()
    expect(normaliseWaitlistEmail(`${'a'.repeat(250)}@example.com`)).toBeNull()
  })
})

describe('normaliseWaitlistLocale', () => {
  it('keeps supported locales and falls back to en', () => {
    for (const l of WAITLIST_LOCALES) expect(normaliseWaitlistLocale(l)).toBe(l)
    expect(normaliseWaitlistLocale('it')).toBe('en')
    expect(normaliseWaitlistLocale(null)).toBe('en')
  })
})

describe('tokens', () => {
  it('generates distinct 256-bit url-safe tokens that parse back', () => {
    const a = generateWaitlistToken()
    const b = generateWaitlistToken()
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[\w-]{43}$/)
    expect(parseWaitlistToken(a)).toBe(a)
  })

  it('hashes deterministically to sha-256 hex, never echoing the raw token', () => {
    const token = generateWaitlistToken()
    const hash = hashWaitlistToken(token)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(hashWaitlistToken(token)).toBe(hash)
    expect(hash).not.toContain(token)
  })

  it('rejects malformed tokens before they reach a DB lookup', () => {
    expect(parseWaitlistToken(undefined)).toBeNull()
    expect(parseWaitlistToken('short')).toBeNull()
    expect(parseWaitlistToken('has spaces in it and is long enough')).toBeNull()
    expect(parseWaitlistToken('\'; drop table waitlist_signups; --')).toBeNull()
  })
})

describe('isWaitlistOpen', () => {
  it('is open only with billing off AND plans coming soon', () => {
    vi.stubEnv('NUXT_BILLING_ENABLED', '')
    vi.stubEnv('NUXT_PLANS_COMING_SOON', '')
    expect(isWaitlistOpen()).toBe(false)
    vi.stubEnv('NUXT_PLANS_COMING_SOON', 'true')
    expect(isWaitlistOpen()).toBe(true)
    vi.stubEnv('NUXT_BILLING_ENABLED', 'true')
    expect(isWaitlistOpen()).toBe(false)
  })
})

describe('buildWaitlistConfirmEmail', () => {
  it('builds confirm + unsubscribe links on the configured origin for every locale', () => {
    for (const locale of WAITLIST_LOCALES) {
      const { subject, body } = buildWaitlistConfirmEmail({
        locale,
        baseUrl: 'https://markoto.app/',
        confirmToken: 'confirm-token-abcdefghijklmnop',
        unsubscribeToken: 'unsub-token-abcdefghijklmnopq'
      })
      expect(subject.length, locale).toBeGreaterThan(0)
      expect(body, locale).toContain('https://markoto.app/waitlist/confirm?token=confirm-token-abcdefghijklmnop')
      expect(body, locale).toContain('https://markoto.app/waitlist/unsubscribe?token=unsub-token-abcdefghijklmnopq')
    }
  })

  it('uses translated copy (not English) for non-English locales', () => {
    const en = buildWaitlistConfirmEmail({ locale: 'en', baseUrl: 'https://x.test', confirmToken: 'c'.repeat(30), unsubscribeToken: 'u'.repeat(30) })
    const de = buildWaitlistConfirmEmail({ locale: 'de', baseUrl: 'https://x.test', confirmToken: 'c'.repeat(30), unsubscribeToken: 'u'.repeat(30) })
    expect(de.subject).not.toBe(en.subject)
    expect(de.subject).toMatch(/Warteliste/)
  })
})
