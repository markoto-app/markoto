import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { isAdminEmail } from '../../server/utils/adminAccess'

// `isAdminEmail` is the bootstrap allowlist parser. It's the
// authority on "is this email on the env-list" — the column-first
// admin check (`isAdminUser` / `requireAdminUser`) defers to this
// for the env-fallback path. Any drift here (e.g. case-sensitive
// match, whitespace breaking the parse) silently locks ops out
// of /admin/*.

const ORIGINAL_ENV = process.env.NUXT_ADMIN_USER_EMAILS

afterEach(() => {
  if (ORIGINAL_ENV === undefined) {
    delete process.env.NUXT_ADMIN_USER_EMAILS
  } else {
    process.env.NUXT_ADMIN_USER_EMAILS = ORIGINAL_ENV
  }
})

describe('isAdminEmail — empty / unset env', () => {
  beforeEach(() => {
    delete process.env.NUXT_ADMIN_USER_EMAILS
  })

  it('returns false when the env var is unset', () => {
    expect(isAdminEmail('joel@latentspace-labs.ch')).toBe(false)
  })

  it('returns false for any input when env is empty string', () => {
    process.env.NUXT_ADMIN_USER_EMAILS = ''
    expect(isAdminEmail('joel@latentspace-labs.ch')).toBe(false)
  })

  it('returns false for null/undefined/empty input', () => {
    process.env.NUXT_ADMIN_USER_EMAILS = 'joel@latentspace-labs.ch'
    expect(isAdminEmail(null)).toBe(false)
    expect(isAdminEmail(undefined)).toBe(false)
    expect(isAdminEmail('')).toBe(false)
  })
})

describe('isAdminEmail — single email', () => {
  beforeEach(() => {
    process.env.NUXT_ADMIN_USER_EMAILS = 'joel@latentspace-labs.ch'
  })

  it('matches exact', () => {
    expect(isAdminEmail('joel@latentspace-labs.ch')).toBe(true)
  })

  it('is case-insensitive on the input', () => {
    expect(isAdminEmail('Joel@LatentSpace-Labs.CH')).toBe(true)
    expect(isAdminEmail('JOEL@LATENTSPACE-LABS.CH')).toBe(true)
  })

  it('rejects non-listed emails', () => {
    expect(isAdminEmail('mallory@evil.com')).toBe(false)
    expect(isAdminEmail('joel@gmail.com')).toBe(false)
  })

  it('rejects substring matches', () => {
    process.env.NUXT_ADMIN_USER_EMAILS = 'joel@latentspace-labs.ch'
    expect(isAdminEmail('not-joel@latentspace-labs.ch')).toBe(false)
    expect(isAdminEmail('joel@latentspace-labs.ch.evil.com')).toBe(false)
  })
})

describe('isAdminEmail — multiple comma-separated', () => {
  it('matches any of the listed entries', () => {
    process.env.NUXT_ADMIN_USER_EMAILS = 'joel@latentspace-labs.ch,founder@latentspace-labs.ch,ops@latentspace-labs.ch'
    expect(isAdminEmail('joel@latentspace-labs.ch')).toBe(true)
    expect(isAdminEmail('founder@latentspace-labs.ch')).toBe(true)
    expect(isAdminEmail('ops@latentspace-labs.ch')).toBe(true)
    expect(isAdminEmail('intern@latentspace-labs.ch')).toBe(false)
  })

  it('tolerates whitespace around commas', () => {
    process.env.NUXT_ADMIN_USER_EMAILS = '  joel@latentspace-labs.ch , founder@latentspace-labs.ch  '
    expect(isAdminEmail('joel@latentspace-labs.ch')).toBe(true)
    expect(isAdminEmail('founder@latentspace-labs.ch')).toBe(true)
  })

  it('case-insensitive on env values too', () => {
    process.env.NUXT_ADMIN_USER_EMAILS = 'Joel@LatentSpace-Labs.CH'
    expect(isAdminEmail('joel@latentspace-labs.ch')).toBe(true)
  })

  it('skips empty segments from accidental double-commas', () => {
    process.env.NUXT_ADMIN_USER_EMAILS = 'joel@latentspace-labs.ch,,founder@latentspace-labs.ch'
    expect(isAdminEmail('joel@latentspace-labs.ch')).toBe(true)
    expect(isAdminEmail('founder@latentspace-labs.ch')).toBe(true)
    expect(isAdminEmail('')).toBe(false) // empty input never matches
  })
})

describe('isAdminEmail — config rotation', () => {
  it('reads the env var on every call (no module-scope cache)', () => {
    process.env.NUXT_ADMIN_USER_EMAILS = 'joel@latentspace-labs.ch'
    expect(isAdminEmail('joel@latentspace-labs.ch')).toBe(true)
    expect(isAdminEmail('founder@latentspace-labs.ch')).toBe(false)

    process.env.NUXT_ADMIN_USER_EMAILS = 'founder@latentspace-labs.ch'
    expect(isAdminEmail('joel@latentspace-labs.ch')).toBe(false)
    expect(isAdminEmail('founder@latentspace-labs.ch')).toBe(true)
  })
})
