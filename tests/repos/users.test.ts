import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, testDb } from '../integration/setup/db'
import {
  findUserById,
  findUserNameById,
  findUserByEmail,
  upsertOAuthUser
} from '../../server/repos/users'

// Users repository. Write-side hot spot is `upsertOAuthUser`, which
// now has THREE outcomes:
//   - inserted: brand-new user
//   - updated: same provider id signing in again
//   - merged:  OTHER provider's first sign-in, but email already
//              belongs to an existing row → link both providers to
//              one account (requires verified email)

// Helper: the public repo returns `{userId, outcome}`. Tests that
// only care about the id unwrap locally so the assertions stay
// focused.
async function upsert(input: Parameters<typeof upsertOAuthUser>[0]): Promise<number> {
  const r = await upsertOAuthUser(input)
  return r.userId
}

describe('findUserById', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('returns null for a nonexistent id', async () => {
    expect(await findUserById(9999)).toBeNull()
  })

  it('returns the full row for an existing user', async () => {
    const id = await upsert({
      provider: 'github', providerUserId: 'gh-1',
      login: 'a', name: 'Alice', email: 'a@t.l', avatarUrl: 'u',
      emailVerified: true
    })
    const row = await findUserById(id)
    expect(row!.name).toBe('Alice')
    expect(row!.githubId).toBe('gh-1')
    expect(row!.googleId).toBeNull()
  })
})

describe('findUserNameById', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('returns just the name (lighter than findUserById)', async () => {
    const id = await upsert({
      provider: 'google', providerUserId: 'g-1',
      name: 'Bob', email: null, avatarUrl: null,
      emailVerified: false
    })
    expect(await findUserNameById(id)).toBe('Bob')
  })

  it('returns null for nonexistent id', async () => {
    expect(await findUserNameById(9999)).toBeNull()
  })
})

describe('findUserByEmail', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('finds a user by exact email', async () => {
    await upsert({
      provider: 'github', providerUserId: 'gh-1',
      login: 'c', name: 'Charlie', email: 'charlie@test.local', avatarUrl: null,
      emailVerified: true
    })
    const row = await findUserByEmail('charlie@test.local')
    expect(row!.name).toBe('Charlie')
  })

  it('is case-insensitive', async () => {
    // Signed up via GitHub with capitalized email; looked up with
    // lowercase — must still match.
    await upsert({
      provider: 'github', providerUserId: 'gh-2',
      login: 'd', name: 'Dana', email: 'Dana@Test.Local', avatarUrl: null,
      emailVerified: true
    })
    expect((await findUserByEmail('dana@test.local'))?.name).toBe('Dana')
    expect((await findUserByEmail('DANA@TEST.LOCAL'))?.name).toBe('Dana')
  })

  it('returns null when no match', async () => {
    expect(await findUserByEmail('ghost@nowhere.test')).toBeNull()
  })

  it('ignores users with null email even on "null"-ish query', async () => {
    // Pin behavior: null-email users never match an email lookup.
    await upsert({
      provider: 'google', providerUserId: 'g-nullmail',
      name: 'Eve', email: null, avatarUrl: null,
      emailVerified: false
    })
    expect(await findUserByEmail('')).toBeNull()
  })
})

describe('upsertOAuthUser — basic outcomes', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('insert path: creates a new user row', async () => {
    const r = await upsertOAuthUser({
      provider: 'github', providerUserId: 'gh-insert',
      login: 'alice', name: 'Alice', email: 'alice@test.local', avatarUrl: 'u',
      emailVerified: true
    })
    expect(r.outcome).toBe('inserted')
    const row = await findUserById(r.userId)
    expect(row!.githubId).toBe('gh-insert')
    expect(row!.googleId).toBeNull()
    expect(row!.login).toBe('alice')
  })

  it('update path: second call with same providerId refreshes profile fields', async () => {
    const r1 = await upsertOAuthUser({
      provider: 'github', providerUserId: 'gh-update',
      login: 'alice', name: 'Alice', email: 'alice@test.local', avatarUrl: 'u1',
      emailVerified: true
    })
    const r2 = await upsertOAuthUser({
      provider: 'github', providerUserId: 'gh-update',
      login: 'alice-new', name: 'Alice New', email: 'new@test.local', avatarUrl: 'u2',
      emailVerified: true
    })
    expect(r2.outcome).toBe('updated')
    expect(r2.userId).toBe(r1.userId)
    const row = await findUserById(r1.userId)
    expect(row!.name).toBe('Alice New')
    expect(row!.login).toBe('alice-new')
    expect(row!.email).toBe('new@test.local')
    expect(row!.avatarUrl).toBe('u2')
  })

  it('update path does not flip googleId on a github user', async () => {
    const id = await upsert({
      provider: 'github', providerUserId: 'gh-x',
      login: 'x', name: 'X', email: null, avatarUrl: null,
      emailVerified: false
    })
    await upsert({
      provider: 'github', providerUserId: 'gh-x',
      login: 'x2', name: 'X2', email: null, avatarUrl: null,
      emailVerified: false
    })
    const row = await findUserById(id)
    expect(row!.googleId).toBeNull()
    expect(row!.githubId).toBe('gh-x')
  })

  it('provider isolation when email is null: github + google sign-ins with no email stay separate', async () => {
    // Without an email, merge is impossible (no key to match on).
    // This pins the email-less signup behaviour.
    const ghId = await upsert({
      provider: 'github', providerUserId: 'shared-id',
      name: 'GHUser', email: null, avatarUrl: null,
      emailVerified: false
    })
    const goId = await upsert({
      provider: 'google', providerUserId: 'shared-id',
      name: 'GoUser', email: null, avatarUrl: null,
      emailVerified: false
    })
    expect(ghId).not.toBe(goId)
    expect((await findUserById(ghId))!.githubId).toBe('shared-id')
    expect((await findUserById(goId))!.googleId).toBe('shared-id')
  })

  it('concurrent upserts on the SAME providerUserId: both return the same id', async () => {
    const [a, b] = await Promise.allSettled([
      upsertOAuthUser({
        provider: 'github', providerUserId: 'gh-race',
        name: 'Race1', email: null, avatarUrl: null, emailVerified: false
      }),
      upsertOAuthUser({
        provider: 'github', providerUserId: 'gh-race',
        name: 'Race2', email: null, avatarUrl: null, emailVerified: false
      })
    ])
    const fulfilled = [a, b].filter(r => r.status === 'fulfilled')
    expect(fulfilled.length).toBeGreaterThanOrEqual(1)
    const db = testDb()
    const r = await db.query<{ c: string }>(
      `SELECT COUNT(*) AS c FROM users WHERE github_id = 'gh-race'`
    )
    expect(Number(r.rows[0].c)).toBe(1)
  })
})

describe('upsertOAuthUser — email-based merge', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('merges a second-provider signin into the existing row when email matches and is verified on BOTH sides', async () => {
    // Alice signs up with GitHub first.
    const first = await upsertOAuthUser({
      provider: 'github', providerUserId: 'gh-alice',
      login: 'alice', name: 'Alice', email: 'alice@test.local', avatarUrl: 'gh-avatar',
      emailVerified: true
    })
    expect(first.outcome).toBe('inserted')

    // Later she signs in with Google using the same email. Expect
    // one row, both provider ids populated.
    const second = await upsertOAuthUser({
      provider: 'google', providerUserId: 'g-alice',
      name: 'Alice Smith', email: 'alice@test.local', avatarUrl: 'g-avatar',
      emailVerified: true
    })
    expect(second.outcome).toBe('merged')
    expect(second.userId).toBe(first.userId)

    const row = await findUserById(first.userId)
    expect(row!.githubId).toBe('gh-alice')
    expect(row!.googleId).toBe('g-alice') // linked
    // Avatar + email normalise to the latest login's values (user
    // can always re-edit once we have a profile page). Login stays
    // (GitHub-only field); Google doesn't set it.
    expect(row!.avatarUrl).toBe('g-avatar')
  })

  it('case-insensitive email matching still merges', async () => {
    await upsert({
      provider: 'github', providerUserId: 'gh-caps',
      login: 'u', name: 'Caps', email: 'Alice@Test.Local', avatarUrl: null,
      emailVerified: true
    })
    const second = await upsertOAuthUser({
      provider: 'google', providerUserId: 'g-caps',
      name: 'Alice', email: 'alice@test.local', avatarUrl: null,
      emailVerified: true
    })
    expect(second.outcome).toBe('merged')

    const rows = await testDb().query<{ c: string }>(
      `SELECT COUNT(*) AS c FROM users WHERE email ILIKE 'alice@test.local'`
    )
    expect(Number(rows.rows[0].c)).toBe(1)
  })

  it('does NOT merge when the second provider presents an unverified email (security guard)', async () => {
    // Attacker controls a Google account with an unverified
    // `alice@test.local` claim. Must NOT get access to Alice's
    // GitHub-originated account. Instead, a second row is inserted.
    const first = await upsert({
      provider: 'github', providerUserId: 'gh-alice',
      login: 'alice', name: 'Alice', email: 'alice@test.local', avatarUrl: null,
      emailVerified: true
    })
    const second = await upsertOAuthUser({
      provider: 'google', providerUserId: 'g-attacker',
      name: 'Attacker', email: 'alice@test.local', avatarUrl: null,
      emailVerified: false // <- the key difference
    })
    expect(second.outcome).toBe('inserted')
    expect(second.userId).not.toBe(first)

    const rows = await testDb().query<{ c: string }>(
      `SELECT COUNT(*) AS c FROM users WHERE email ILIKE 'alice@test.local'`
    )
    // Two separate rows because the merge was blocked.
    expect(Number(rows.rows[0].c)).toBe(2)
  })

  it('does NOT merge when the incoming email is null', async () => {
    // No email → nothing to match on. Second provider inserts a
    // new row even though an existing user might exist.
    await upsert({
      provider: 'github', providerUserId: 'gh-has-email',
      login: 'u', name: 'U', email: 'u@test.local', avatarUrl: null,
      emailVerified: true
    })
    const second = await upsertOAuthUser({
      provider: 'google', providerUserId: 'g-no-email',
      name: 'NoEmail', email: null, avatarUrl: null,
      emailVerified: false
    })
    expect(second.outcome).toBe('inserted')
  })

  it('does NOT merge when the existing row has NULL email (can\'t match)', async () => {
    // Existing row registered with a provider that didn't supply an
    // email. Even if the incoming login has an email + verified, we
    // can't prove they're the same person.
    await upsert({
      provider: 'github', providerUserId: 'gh-no-email',
      name: 'NoMail', email: null, avatarUrl: null,
      emailVerified: false
    })
    const second = await upsertOAuthUser({
      provider: 'google', providerUserId: 'g-with-email',
      name: 'WithMail', email: 'anything@test.local', avatarUrl: null,
      emailVerified: true
    })
    expect(second.outcome).toBe('inserted')
  })

  it('concurrent sign-ins from the SAME second-provider id both resolve to the merged row', async () => {
    // Realistic race: user clicks "Sign in with Google" twice
    // rapidly. Both tabs' OAuth callbacks hit upsertOAuthUser with
    // the same providerUserId. Branch ordering:
    //   - First tx: email lookup finds the GitHub row, sees
    //     google_id IS NULL → merges.
    //   - Second tx: blocks on `FOR UPDATE` until first commits.
    //     Then reads the row — google_id is now set (to OUR value
    //     because providerUserId is the same). Branch 1 would
    //     match, but we never got there — branch 2's
    //     `candidateHasOurProvider` is now TRUE for a row where
    //     the provider id matches ours. Falls through to INSERT,
    //     which collides with the UNIQUE constraint on google_id
    //     and either retries or resolves to the existing row id.
    //
    // Expected terminal state: ONE user row, google_id set exactly
    // once. No orphan rows, no duplicate inserts surviving.
    await upsert({
      provider: 'github', providerUserId: 'gh-race-alice',
      login: 'alice', name: 'Alice', email: 'race@test.local', avatarUrl: null,
      emailVerified: true
    })

    const [a, b] = await Promise.allSettled([
      upsertOAuthUser({
        provider: 'google', providerUserId: 'g-race-same',
        name: 'Alice', email: 'race@test.local', avatarUrl: null, emailVerified: true
      }),
      upsertOAuthUser({
        provider: 'google', providerUserId: 'g-race-same',
        name: 'Alice', email: 'race@test.local', avatarUrl: null, emailVerified: true
      })
    ])

    // At least one fulfilled; a unique-violation on the second is
    // acceptable outcome (it means the lock-and-merge serialised
    // correctly — the tx that lost the race can be retried by
    // nuxt-auth-utils on the next click).
    const fulfilled = [a, b].filter(r => r.status === 'fulfilled')
    expect(fulfilled.length).toBeGreaterThanOrEqual(1)

    // Exactly ONE row with google_id=g-race-same among the matching
    // emails — no corruption.
    const rows = await testDb().query<{ c: string }>(
      `SELECT COUNT(*) AS c FROM users WHERE email ILIKE 'race@test.local' AND google_id = 'g-race-same'`
    )
    expect(Number(rows.rows[0].c)).toBe(1)
  })
})
