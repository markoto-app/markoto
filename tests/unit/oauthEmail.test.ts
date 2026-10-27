import { describe, expect, it, vi } from 'vitest'
import { githubVerifiedEmail, googleVerifiedEmail, type GitHubEmailEntry } from '../../server/utils/oauthEmail'

// Only VERIFIED provider emails may be stored / merged / matched against
// the admin allowlist. An unverified address equal to the admin's would
// otherwise be promoted to admin on first sign-in.

describe('googleVerifiedEmail', () => {
  it('returns the email only when email_verified is the boolean true', () => {
    expect(googleVerifiedEmail({ email: 'a@example.com', email_verified: true })).toBe('a@example.com')
    expect(googleVerifiedEmail({ email: 'a@example.com', email_verified: false })).toBeNull()
    expect(googleVerifiedEmail({ email: 'a@example.com' })).toBeNull()
    expect(googleVerifiedEmail({ email: null, email_verified: true })).toBeNull()
  })
})

describe('githubVerifiedEmail', () => {
  const emails: GitHubEmailEntry[] = [
    { email: 'primary@example.com', primary: true, verified: true },
    { email: 'public@example.com', primary: false, verified: true },
    { email: 'unverified@example.com', primary: false, verified: false }
  ]

  it('trusts an email nuxt-auth-utils already resolved as verified (no extra lookup)', async () => {
    const list = vi.fn(async () => emails)
    expect(await githubVerifiedEmail({ email: 'primary@example.com', email_verified: true }, list)).toBe('primary@example.com')
    expect(list).not.toHaveBeenCalled()
  })

  it('checks the public profile email against /user/emails', async () => {
    expect(await githubVerifiedEmail({ email: 'Public@Example.com' }, async () => emails)).toBe('public@example.com')
    expect(await githubVerifiedEmail({ email: 'unverified@example.com' }, async () => emails)).toBeNull()
    expect(await githubVerifiedEmail({ email: 'not-listed@example.com' }, async () => emails)).toBeNull()
  })

  it('refuses an email flagged unverified', async () => {
    const unverifiedPrimary: GitHubEmailEntry[] = [{ email: 'p@example.com', primary: true, verified: false }]
    expect(await githubVerifiedEmail({ email: 'p@example.com', email_verified: false }, async () => unverifiedPrimary)).toBeNull()
  })

  it('uses the verified primary address when the profile has no email', async () => {
    expect(await githubVerifiedEmail({ email: null }, async () => emails)).toBe('primary@example.com')
  })

  it('returns null when the lookup fails', async () => {
    expect(await githubVerifiedEmail({ email: 'public@example.com' }, async () => {
      throw new Error('network')
    })).toBeNull()
  })
})
