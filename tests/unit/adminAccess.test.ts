import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { isAdminEmail } from '../../server/utils/adminAccess'

// `isAdminEmail` is the bootstrap allowlist parser. It's the
// authority on "is this email on the env-list" — the sign-in bootstrap
// (`bootstrapAdminFromEnv`, verified emails only) defers to this to set
// `users.is_admin`. Any drift here (e.g. case-sensitive match,
// whitespace breaking the parse) silently locks ops out of /admin/*.
// The check-time behaviour (column only) is pinned by
// adminAccessColumn.test.ts.

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
    expect(isAdminEmail('admin@example.com')).toBe(false)
  })

  it('returns false for any input when env is empty string', () => {
    process.env.NUXT_ADMIN_USER_EMAILS = ''
    expect(isAdminEmail('admin@example.com')).toBe(false)
  })

  it('returns false for null/undefined/empty input', () => {
    process.env.NUXT_ADMIN_USER_EMAILS = 'admin@example.com'
    expect(isAdminEmail(null)).toBe(false)
    expect(isAdminEmail(undefined)).toBe(false)
    expect(isAdminEmail('')).toBe(false)
  })
})

describe('isAdminEmail — single email', () => {
  beforeEach(() => {
    process.env.NUXT_ADMIN_USER_EMAILS = 'admin@example.com'
  })

  it('matches exact', () => {
    expect(isAdminEmail('admin@example.com')).toBe(true)
  })

  it('is case-insensitive on the input', () => {
    expect(isAdminEmail('Admin@Example.COM')).toBe(true)
    expect(isAdminEmail('ADMIN@EXAMPLE.COM')).toBe(true)
  })

  it('rejects non-listed emails', () => {
    expect(isAdminEmail('mallory@evil.com')).toBe(false)
    expect(isAdminEmail('admin@example.net')).toBe(false)
  })

  it('rejects substring matches', () => {
    process.env.NUXT_ADMIN_USER_EMAILS = 'admin@example.com'
    expect(isAdminEmail('not-admin@example.com')).toBe(false)
    expect(isAdminEmail('admin@example.com.evil.com')).toBe(false)
  })
})

describe('isAdminEmail — multiple comma-separated', () => {
  it('matches any of the listed entries', () => {
    process.env.NUXT_ADMIN_USER_EMAILS = 'admin@example.com,founder@example.com,ops@example.com'
    expect(isAdminEmail('admin@example.com')).toBe(true)
    expect(isAdminEmail('founder@example.com')).toBe(true)
    expect(isAdminEmail('ops@example.com')).toBe(true)
    expect(isAdminEmail('intern@example.com')).toBe(false)
  })

  it('tolerates whitespace around commas', () => {
    process.env.NUXT_ADMIN_USER_EMAILS = '  admin@example.com , founder@example.com  '
    expect(isAdminEmail('admin@example.com')).toBe(true)
    expect(isAdminEmail('founder@example.com')).toBe(true)
  })

  it('case-insensitive on env values too', () => {
    process.env.NUXT_ADMIN_USER_EMAILS = 'Admin@Example.COM'
    expect(isAdminEmail('admin@example.com')).toBe(true)
  })

  it('skips empty segments from accidental double-commas', () => {
    process.env.NUXT_ADMIN_USER_EMAILS = 'admin@example.com,,founder@example.com'
    expect(isAdminEmail('admin@example.com')).toBe(true)
    expect(isAdminEmail('founder@example.com')).toBe(true)
    expect(isAdminEmail('')).toBe(false) // empty input never matches
  })
})

describe('isAdminEmail — config rotation', () => {
  it('reads the env var on every call (no module-scope cache)', () => {
    process.env.NUXT_ADMIN_USER_EMAILS = 'admin@example.com'
    expect(isAdminEmail('admin@example.com')).toBe(true)
    expect(isAdminEmail('founder@example.com')).toBe(false)

    process.env.NUXT_ADMIN_USER_EMAILS = 'founder@example.com'
    expect(isAdminEmail('admin@example.com')).toBe(false)
    expect(isAdminEmail('founder@example.com')).toBe(true)
  })
})
