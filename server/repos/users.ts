import { and, eq, isNull, sql } from 'drizzle-orm'
import { users } from '../db/schema'
import { useDatabase } from '../utils/database'

// Users repository. The OAuth handlers do an "upsert by provider id",
// so the write path is a single `upsertOAuthUser` that replaces the
// `select → if existing update else insert → re-select id` dance
// github.get.ts / google.get.ts used to open-code.

export type Provider = 'github' | 'google'

export interface UserRow {
  id: number
  githubId: string | null
  googleId: string | null
  login: string | null
  name: string
  email: string | null
  avatarUrl: string | null
  createdAt: Date
}

export interface OAuthUpsertInput {
  provider: Provider
  providerUserId: string
  login?: string | null
  name: string
  email: string | null
  avatarUrl: string | null
  /**
   * Whether the email returned by the OAuth provider is verified.
   * Gates the email-based account merge path: we only merge a new
   * login into an existing row if BOTH sides present the same
   * verified email. Otherwise an attacker who can claim an
   * arbitrary email at one provider could take over someone else's
   * account at another.
   *
   * - GitHub: the userinfo endpoint only returns the primary email
   *   when `emailRequired: true` is set, and GitHub only lists an
   *   email as primary after it's been verified. So for our
   *   GitHub flow, `email != null` ⇒ verified.
   * - Google: OIDC userinfo returns `email_verified: boolean`
   *   directly. Pipe that through.
   */
  emailVerified: boolean
}

/**
 * Outcome returned from `upsertOAuthUser` so callers can show a
 * flash message like "linked your Google login to your existing
 * account". Pure diagnostic — the user id is what drives the
 * session cookie either way.
 */
export type OAuthUpsertOutcome = 'inserted' | 'updated' | 'merged'

export interface OAuthUpsertResult {
  userId: number
  outcome: OAuthUpsertOutcome
}

export async function findUserById(id: number): Promise<UserRow | null> {
  const db = useDatabase()
  const row = (await db.select().from(users).where(eq(users.id, id)).limit(1))[0]
  return row ?? null
}

export async function findUserNameById(id: number): Promise<string | null> {
  const db = useDatabase()
  const row = (await db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, id))
    .limit(1))[0]
  return row?.name ?? null
}

/**
 * Case-insensitive email lookup. Used by the workspace-invite endpoint.
 * Users sign up via GitHub/Google and the provider's casing may differ
 * from what the inviter types.
 */
export async function findUserByEmail(email: string): Promise<Pick<UserRow, 'id' | 'name' | 'email' | 'login' | 'avatarUrl'> | null> {
  const db = useDatabase()
  const row = (await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      login: users.login,
      avatarUrl: users.avatarUrl
    })
    .from(users)
    .where(sql`lower(${users.email}) = lower(${email})`)
    .limit(1))[0]
  return row ?? null
}

/**
 * Upsert a user by OAuth provider id.
 *
 * Three outcomes:
 *
 *   1. **updated** — the provider id matches an existing row. Refresh
 *      the profile fields (name, email, avatarUrl, login-for-github)
 *      in case the user updated them on the provider. Legacy path.
 *
 *   2. **merged** — the provider id is new, BUT the verified email
 *      matches a row with the OTHER provider id set. Add our
 *      provider id to that existing row so the user can sign in
 *      with either provider going forward. This is what keeps a
 *      "I signed up with GitHub; now let me try Google" second
 *      login from creating a ghost account. Gated on
 *      `emailVerified=true` so an attacker who can't prove the
 *      email is theirs (e.g. a provider that doesn't verify) can't
 *      take over someone else's account.
 *
 *   3. **inserted** — genuinely new user. No provider-id match, no
 *      mergeable email hit.
 *
 * Ordering rules for case #2 (the merge):
 *   - Only merge if the candidate row has NULL for OUR provider id.
 *     If both provider ids are already set on that row, something
 *     is wrong (or legacy data has the email duplicated across two
 *     accounts) — insert instead.
 *   - `SELECT FOR UPDATE` locks the candidate row for the tx so
 *     two concurrent logins of the same email can't both merge
 *     (which would corrupt "only one of us wins" into "both append
 *     our provider id to different rows with the same provider
 *     now set").
 */
export async function upsertOAuthUser(input: OAuthUpsertInput): Promise<OAuthUpsertResult> {
  const db = useDatabase()
  const whereByProviderId = input.provider === 'github'
    ? eq(users.githubId, input.providerUserId)
    : eq(users.googleId, input.providerUserId)
  const otherProviderColumn = input.provider === 'github'
    ? users.googleId
    : users.githubId

  return db.transaction(async (tx): Promise<OAuthUpsertResult> => {
    // Branch 1: provider id already on file.
    const existing = (await tx
      .select({ id: users.id })
      .from(users)
      .where(whereByProviderId)
      .limit(1))[0]

    if (existing) {
      await tx.update(users)
        .set({
          name: input.name,
          email: input.email,
          avatarUrl: input.avatarUrl,
          ...(input.provider === 'github' ? { login: input.login } : {})
        })
        .where(and(whereByProviderId))
      return { userId: existing.id, outcome: 'updated' }
    }

    // Branch 2: email-based merge. Locked with `FOR UPDATE` so a
    // concurrent second-provider login for the same email serialises
    // (second tx sees either our merged row or — if we haven't
    // committed — waits + then sees the merged state).
    if (input.emailVerified && input.email) {
      const mergeCandidate = (await tx.execute<{ id: number, github_id: string | null, google_id: string | null }>(sql`
        SELECT id, github_id, google_id FROM ${users}
        WHERE lower(email) = lower(${input.email})
        LIMIT 1
        FOR UPDATE
      `)).rows?.[0]

      if (mergeCandidate) {
        const candidateHasOurProvider = input.provider === 'github'
          ? mergeCandidate.github_id !== null
          : mergeCandidate.google_id !== null
        if (!candidateHasOurProvider) {
          // Merge: add our provider id to the existing row. Keep
          // name/avatar from the first provider — the user chose
          // those and may have customised via `/profile` (once we
          // have that page). Updating login only if we're GitHub
          // (Google has no equivalent).
          const setClause: Record<string, unknown> = {
            [input.provider === 'github' ? 'githubId' : 'googleId']: input.providerUserId,
            email: input.email, // normalise casing to what the second provider gave us
            avatarUrl: input.avatarUrl
          }
          if (input.provider === 'github') setClause.login = input.login ?? null
          await tx.update(users)
            .set(setClause)
            .where(eq(users.id, mergeCandidate.id))
          return { userId: mergeCandidate.id, outcome: 'merged' }
        }
        // Else: candidate has our provider id already set but to a
        // DIFFERENT value (otherwise branch 1 would have matched).
        // This means the email is duplicated across two accounts —
        // legacy pre-merge-feature data. Don't merge silently; fall
        // through to insert so both accounts stay separate.
      }
    }

    // Branch 3: genuinely new user.
    const inserted = await tx.insert(users).values({
      githubId: input.provider === 'github' ? input.providerUserId : null,
      googleId: input.provider === 'google' ? input.providerUserId : null,
      login: input.login ?? null,
      name: input.name,
      email: input.email,
      avatarUrl: input.avatarUrl
    }).returning({ id: users.id })
    void otherProviderColumn // touched for future auditability; ref kept
    return { userId: inserted[0]!.id, outcome: 'inserted' }
  })
}
