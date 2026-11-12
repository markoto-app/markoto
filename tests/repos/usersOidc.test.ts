import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, testDb } from '../integration/setup/db'
import { findUserById } from '../../server/repos/users'
import { asUser } from '../helpers/access'
import { upsertOAuthUser } from '../../server/repos/userSignIn'

// Generic OIDC: identities are keyed by (issuer, sub) — never the
// email — and only a VERIFIED email merges into an existing account,
// same rule as GitHub/Google (tests/repos/users.test.ts).

const ISSUER = 'https://idp.example.org/realms/markoto'
const OTHER_ISSUER = 'https://other-idp.example.org'

async function upsert(input: Parameters<typeof upsertOAuthUser>[0]): Promise<number> {
  return (await upsertOAuthUser(input)).userId
}

describe('upsertOAuthUser — generic OIDC', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('inserts, then updates the same row for the same (issuer, sub)', async () => {
    const first = await upsertOAuthUser({
      provider: 'oidc', oidcIssuer: ISSUER, providerUserId: 'sub-1',
      name: 'Olga', email: 'olga@test.local', emailVerified: true
    })
    expect(first.outcome).toBe('inserted')
    const again = await upsertOAuthUser({
      provider: 'oidc', oidcIssuer: ISSUER, providerUserId: 'sub-1',
      name: 'Olga Renamed', email: 'olga@test.local', emailVerified: true
    })
    expect(again).toEqual({ userId: first.userId, outcome: 'updated' })
    const row = await findUserById(asUser(first.userId))
    expect(row).toMatchObject({ oidcIssuer: ISSUER, oidcSubject: 'sub-1', name: 'Olga Renamed', githubId: null, googleId: null })
  })

  it('the same sub at a different issuer is a different identity', async () => {
    const a = await upsert({
      provider: 'oidc', oidcIssuer: ISSUER, providerUserId: 'shared-sub',
      name: 'A', email: null, emailVerified: false
    })
    const b = await upsertOAuthUser({
      provider: 'oidc', oidcIssuer: OTHER_ISSUER, providerUserId: 'shared-sub',
      name: 'B', email: null, emailVerified: false
    })
    expect(b.outcome).toBe('inserted')
    expect(b.userId).not.toBe(a)
  })

  it('a GitHub id equal to an OIDC sub does not collide', async () => {
    const gh = await upsert({
      provider: 'github', providerUserId: '12345', login: 'x', name: 'X',
      email: null, emailVerified: false
    })
    const o = await upsertOAuthUser({
      provider: 'oidc', oidcIssuer: ISSUER, providerUserId: '12345',
      name: 'Y', email: null, emailVerified: false
    })
    expect(o.outcome).toBe('inserted')
    expect(o.userId).not.toBe(gh)
  })

  it('merges into an existing GitHub account on a verified matching email', async () => {
    const gh = await upsert({
      provider: 'github', providerUserId: 'gh-olga', login: 'olga', name: 'Olga',
      email: 'Olga@Test.Local', emailVerified: true
    })
    const o = await upsertOAuthUser({
      provider: 'oidc', oidcIssuer: ISSUER, providerUserId: 'sub-olga',
      name: 'Olga', email: 'olga@test.local', emailVerified: true
    })
    expect(o).toEqual({ userId: gh, outcome: 'merged' })
    expect(await findUserById(asUser(gh))).toMatchObject({ githubId: 'gh-olga', oidcIssuer: ISSUER, oidcSubject: 'sub-olga' })
    // From now on the OIDC identity resolves to the same row.
    const again = await upsertOAuthUser({
      provider: 'oidc', oidcIssuer: ISSUER, providerUserId: 'sub-olga',
      name: 'Olga', email: 'olga@test.local', emailVerified: true
    })
    expect(again).toEqual({ userId: gh, outcome: 'updated' })
  })

  it('does NOT merge on an unverified email', async () => {
    const gh = await upsert({
      provider: 'github', providerUserId: 'gh-victim', login: 'v', name: 'Victim',
      email: 'victim@test.local', emailVerified: true
    })
    const o = await upsertOAuthUser({
      provider: 'oidc', oidcIssuer: ISSUER, providerUserId: 'sub-attacker',
      name: 'Attacker', email: 'victim@test.local', emailVerified: false
    })
    expect(o.outcome).toBe('inserted')
    expect(o.userId).not.toBe(gh)
    expect((await findUserById(asUser(gh)))?.oidcSubject).toBeNull()
  })

  it('does NOT re-point an account that already has an OIDC identity (other issuer)', async () => {
    const first = await upsert({
      provider: 'oidc', oidcIssuer: OTHER_ISSUER, providerUserId: 'old-sub',
      name: 'Olga', email: 'olga@test.local', emailVerified: true
    })
    const second = await upsertOAuthUser({
      provider: 'oidc', oidcIssuer: ISSUER, providerUserId: 'new-sub',
      name: 'Olga', email: 'olga@test.local', emailVerified: true
    })
    expect(second.outcome).toBe('inserted')
    expect(second.userId).not.toBe(first)
    expect(await findUserById(asUser(first))).toMatchObject({ oidcIssuer: OTHER_ISSUER, oidcSubject: 'old-sub' })
  })

  it('a later Google login merges into an OIDC-created account (verified email)', async () => {
    const o = await upsert({
      provider: 'oidc', oidcIssuer: ISSUER, providerUserId: 'sub-1',
      name: 'Olga', email: 'olga@test.local', emailVerified: true
    })
    const g = await upsertOAuthUser({
      provider: 'google', providerUserId: 'g-olga',
      name: 'Olga', email: 'olga@test.local', emailVerified: true
    })
    expect(g).toEqual({ userId: o, outcome: 'merged' })
  })

  it('the database refuses half an OIDC identity', async () => {
    await expect(testDb().query(
      `INSERT INTO users (name, oidc_issuer) VALUES ('Half', 'https://idp.example.org')`
    )).rejects.toThrow(/ck_users_oidc_identity_pair/)
  })

  it('the database refuses a duplicate (issuer, sub)', async () => {
    await upsert({
      provider: 'oidc', oidcIssuer: ISSUER, providerUserId: 'dup',
      name: 'A', email: null, emailVerified: false
    })
    await expect(testDb().query(
      `INSERT INTO users (name, oidc_issuer, oidc_subject) VALUES ('B', $1, 'dup')`,
      [ISSUER]
    )).rejects.toThrow(/uq_users_oidc_identity/)
  })
})
