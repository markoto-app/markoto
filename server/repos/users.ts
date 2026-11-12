import { eq, sql } from 'drizzle-orm'
import { users } from '../db/schema'
import { useDatabase } from '../db/client'
import type { AdminActor, SystemActor, UserScope } from './proofs'

// Users repository: the account row, lookups and the session epoch. Sign-in
// (OAuth upsert) is `userSignIn.ts`, policy acceptance `userPolicies.ts`,
// the deletion request `userDeletionRequests.ts`, Stripe / plan columns
// `userBilling.ts`.

export interface UserRow {
  id: number
  githubId: string | null
  googleId: string | null
  oidcIssuer: string | null
  oidcSubject: string | null
  login: string | null
  name: string
  email: string | null
  stripeCustomerId: string | null
  isAdmin: boolean
  createdAt: Date
  /** Onboarding / policy acceptance — read by the server-side onboarding gate. */
  ageConfirmedAt: Date | null
  privacyVersionAccepted: number | null
  tosVersionAccepted: number | null
  /** Preferred locale (NULL = never chosen). */
  locale: string | null
  /** Session revocation counter — see `server/utils/auth/sessionPolicy.ts`. */
  sessionEpoch: number
}

export async function findUserById(id: number): Promise<UserRow | null> {
  const db = useDatabase()
  const row = (await db.select().from(users).where(eq(users.id, id)).limit(1))[0]
  return row ?? null
}

/** The user's current session epoch (0 for a missing user). */
export async function getSessionEpoch(userId: number): Promise<number> {
  const db = useDatabase()
  const row = (await db
    .select({ sessionEpoch: users.sessionEpoch })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1))[0]
  return row?.sessionEpoch ?? 0
}

/**
 * Increment the session epoch, invalidating every session cookie sealed
 * before this call. Returns the new epoch (null when the user is gone).
 */
export async function bumpSessionEpoch(self: UserScope): Promise<number | null> {
  const userId = self.userId
  const db = useDatabase()
  const row = (await db
    .update(users)
    .set({ sessionEpoch: sql`${users.sessionEpoch} + 1` })
    .where(eq(users.id, userId))
    .returning({ sessionEpoch: users.sessionEpoch }))[0]
  return row?.sessionEpoch ?? null
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
export async function findUserByEmail(email: string): Promise<Pick<UserRow, 'id' | 'name' | 'email' | 'login'> | null> {
  const db = useDatabase()
  const row = (await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      login: users.login
    })
    .from(users)
    .where(sql`lower(${users.email}) = lower(${email})`)
    .limit(1))[0]
  return row ?? null
}

/**
 * Set the `is_admin` flag. Mutation only: the caller writes the audit-log entry.
 * Returns the previous value so the caller can skip auditing no-op flips.
 */
export async function setAdminFlag(_by: AdminActor | SystemActor, userId: number, value: boolean): Promise<{ previous: boolean } | null> {
  const db = useDatabase()
  const before = (await db
    .select({ isAdmin: users.isAdmin })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1))[0]
  if (!before) return null
  if (before.isAdmin === value) return { previous: before.isAdmin }
  await db.update(users)
    .set({ isAdmin: value })
    .where(eq(users.id, userId))
  return { previous: before.isAdmin }
}

/** What creating a workspace checks about the creator: their plan and DPA acceptance. */
export async function getWorkspaceCreationFacts(self: UserScope): Promise<{ plan: 'free' | 'pro', planValidUntil: Date | null, dpaVersionAccepted: number | null } | null> {
  return (await useDatabase().select({
    plan: users.plan,
    planValidUntil: users.planValidUntil,
    dpaVersionAccepted: users.dpaVersionAccepted
  }).from(users).where(eq(users.id, self.userId)).limit(1))[0] ?? null
}

/** The user's platform chat model pick (`fast` / `strong`). */
export async function setAiModelTier(self: UserScope, tier: 'fast' | 'strong'): Promise<void> {
  await useDatabase().update(users).set({ aiModelTier: tier }).where(eq(users.id, self.userId))
}

/** The stored pick, read when resolving the providers for that user's own AI calls. */
export async function getAiModelTier(userId: number): Promise<'fast' | 'strong' | null> {
  return (await useDatabase().select({ tier: users.aiModelTier }).from(users).where(eq(users.id, userId)).limit(1))[0]?.tier ?? null
}
