import { and, eq, sql } from 'drizzle-orm'
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
 * Upsert a user by OAuth provider id. On first sign-in, inserts a new
 * row. On every subsequent sign-in, refreshes the profile fields (name,
 * email, avatarUrl, login-for-github) in case the user updated them on
 * the provider.
 *
 * Returns the user id — callers use it to mint the session cookie.
 */
export async function upsertOAuthUser(input: OAuthUpsertInput): Promise<number> {
  const db = useDatabase()
  const whereClause = input.provider === 'github'
    ? eq(users.githubId, input.providerUserId)
    : eq(users.googleId, input.providerUserId)

  return db.transaction(async (tx) => {
    const existing = (await tx
      .select({ id: users.id })
      .from(users)
      .where(whereClause)
      .limit(1))[0]

    if (existing) {
      await tx.update(users)
        .set({
          name: input.name,
          email: input.email,
          avatarUrl: input.avatarUrl,
          ...(input.provider === 'github' ? { login: input.login } : {})
        })
        .where(and(whereClause))
      return existing.id
    }

    const inserted = await tx.insert(users).values({
      githubId: input.provider === 'github' ? input.providerUserId : null,
      googleId: input.provider === 'google' ? input.providerUserId : null,
      login: input.login ?? null,
      name: input.name,
      email: input.email,
      avatarUrl: input.avatarUrl
    }).returning({ id: users.id })
    return inserted[0]!.id
  })
}
