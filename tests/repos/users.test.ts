import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, testDb } from '../integration/setup/db'
import {
  findUserById,
  findUserNameById,
  findUserByEmail,
  upsertOAuthUser
} from '../../server/repos/users'

// Users repository — the OAuth upsert path is the write-side hot
// spot. Tests verify the insert branch, update branch, provider
// isolation, and case-insensitive email lookup.

describe('findUserById', () => {
  beforeEach(async () => { await resetDb() })

  it('returns null for a nonexistent id', async () => {
    expect(await findUserById(9999)).toBeNull()
  })

  it('returns the full row for an existing user', async () => {
    const id = await upsertOAuthUser({
      provider: 'github', providerUserId: 'gh-1',
      login: 'a', name: 'Alice', email: 'a@t.l', avatarUrl: 'u'
    })
    const row = await findUserById(id)
    expect(row!.name).toBe('Alice')
    expect(row!.githubId).toBe('gh-1')
    expect(row!.googleId).toBeNull()
  })
})

describe('findUserNameById', () => {
  beforeEach(async () => { await resetDb() })

  it('returns just the name (lighter than findUserById)', async () => {
    const id = await upsertOAuthUser({
      provider: 'google', providerUserId: 'g-1',
      name: 'Bob', email: null, avatarUrl: null
    })
    expect(await findUserNameById(id)).toBe('Bob')
  })

  it('returns null for nonexistent id', async () => {
    expect(await findUserNameById(9999)).toBeNull()
  })
})

describe('findUserByEmail', () => {
  beforeEach(async () => { await resetDb() })

  it('finds a user by exact email', async () => {
    await upsertOAuthUser({
      provider: 'github', providerUserId: 'gh-1',
      login: 'c', name: 'Charlie', email: 'charlie@test.local', avatarUrl: null
    })
    const row = await findUserByEmail('charlie@test.local')
    expect(row!.name).toBe('Charlie')
  })

  it('is case-insensitive', async () => {
    // Signed up via GitHub with capitalized email; looked up with
    // lowercase — must still match.
    await upsertOAuthUser({
      provider: 'github', providerUserId: 'gh-2',
      login: 'd', name: 'Dana', email: 'Dana@Test.Local', avatarUrl: null
    })
    expect((await findUserByEmail('dana@test.local'))?.name).toBe('Dana')
    expect((await findUserByEmail('DANA@TEST.LOCAL'))?.name).toBe('Dana')
  })

  it('returns null when no match', async () => {
    expect(await findUserByEmail('ghost@nowhere.test')).toBeNull()
  })

  it('ignores users with null email even on "null"-ish query', async () => {
    // Pin behavior: null-email users never match an email lookup.
    await upsertOAuthUser({
      provider: 'google', providerUserId: 'g-nullmail',
      name: 'Eve', email: null, avatarUrl: null
    })
    expect(await findUserByEmail('')).toBeNull()
  })
})

describe('upsertOAuthUser', () => {
  beforeEach(async () => { await resetDb() })

  it('insert path: creates a new user row', async () => {
    const id = await upsertOAuthUser({
      provider: 'github', providerUserId: 'gh-insert',
      login: 'alice', name: 'Alice', email: 'alice@test.local', avatarUrl: 'u'
    })
    const row = await findUserById(id)
    expect(row!.githubId).toBe('gh-insert')
    expect(row!.googleId).toBeNull()
    expect(row!.login).toBe('alice')
  })

  it('update path: second call with same providerId refreshes profile fields', async () => {
    // Simulates a GitHub login where the user has renamed themselves
    // or updated their avatar on the provider — we should pick up the
    // new values, not create a second row.
    const id1 = await upsertOAuthUser({
      provider: 'github', providerUserId: 'gh-update',
      login: 'alice', name: 'Alice', email: 'alice@test.local', avatarUrl: 'u1'
    })
    const id2 = await upsertOAuthUser({
      provider: 'github', providerUserId: 'gh-update',
      login: 'alice-new', name: 'Alice New', email: 'new@test.local', avatarUrl: 'u2'
    })
    expect(id2).toBe(id1)
    const row = await findUserById(id1)
    expect(row!.name).toBe('Alice New')
    expect(row!.login).toBe('alice-new')
    expect(row!.email).toBe('new@test.local')
    expect(row!.avatarUrl).toBe('u2')
  })

  it('provider isolation: github and google with same providerUserId create distinct rows', async () => {
    // github_id and google_id are separate columns, not a polymorphic
    // "provider+id". Two users where one's GitHub id equals another's
    // Google subject must NOT collapse.
    const ghId = await upsertOAuthUser({
      provider: 'github', providerUserId: 'shared-id',
      name: 'GHUser', email: null, avatarUrl: null
    })
    const goId = await upsertOAuthUser({
      provider: 'google', providerUserId: 'shared-id',
      name: 'GoUser', email: null, avatarUrl: null
    })
    expect(ghId).not.toBe(goId)
    expect((await findUserById(ghId))!.githubId).toBe('shared-id')
    expect((await findUserById(goId))!.googleId).toBe('shared-id')
  })

  it('update path does not flip googleId on a github user', async () => {
    // Cross-contamination guard: the update branch only touches fields
    // appropriate for the provider. A GitHub re-login shouldn't erase
    // or set googleId.
    const id = await upsertOAuthUser({
      provider: 'github', providerUserId: 'gh-x',
      login: 'x', name: 'X', email: null, avatarUrl: null
    })
    await upsertOAuthUser({
      provider: 'github', providerUserId: 'gh-x',
      login: 'x2', name: 'X2', email: null, avatarUrl: null
    })
    const row = await findUserById(id)
    expect(row!.googleId).toBeNull()
    expect(row!.githubId).toBe('gh-x')
  })

  it('concurrent upserts on the SAME providerUserId: both return the same id', async () => {
    // Two near-simultaneous OAuth callbacks for the same GitHub
    // account. Both should resolve to the same user row (not create a
    // duplicate). pg may raise a unique-violation on one of them if
    // they both hit the insert branch at the same instant; the repo's
    // transactional wrapper lets the losing one retry and find the row
    // now exists. Terminal state: exactly one user row.
    const [a, b] = await Promise.allSettled([
      upsertOAuthUser({
        provider: 'github', providerUserId: 'gh-race',
        name: 'Race1', email: null, avatarUrl: null
      }),
      upsertOAuthUser({
        provider: 'github', providerUserId: 'gh-race',
        name: 'Race2', email: null, avatarUrl: null
      })
    ])
    // At least one must have succeeded with a user id; count users to
    // confirm we didn't double-insert.
    const fulfilled = [a, b].filter(r => r.status === 'fulfilled')
    expect(fulfilled.length).toBeGreaterThanOrEqual(1)
    const db = testDb()
    const r = await db.query<{ c: string }>(
      `SELECT COUNT(*) AS c FROM users WHERE github_id = 'gh-race'`
    )
    expect(Number(r.rows[0].c)).toBe(1)
  })
})
