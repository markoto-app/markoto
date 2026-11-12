import { and, eq, isNotNull, isNull, ne } from 'drizzle-orm'
import { users, workspaceMembers, workspaceSubscriptions } from '../db/schema'
import { useDatabase } from '../db/client'

// Where the LiteLLM virtual keys live: a user's personal key on `users`, a
// member's key in a Team / Business workspace's team on the membership row,
// the team id on the subscription row. Tokens are stored sealed (the
// LiteLLM layer seals and opens them). Keyed by the paying subject's id:
// the billing / LiteLLM layer resolves the subject for an AI call of that
// same user, or reconciles all of them as a named job.

export interface StoredUserKey { keyId: string | null, keyToken: string | null }

export async function getStoredUserKey(userId: number): Promise<StoredUserKey | null> {
  return (await useDatabase().select({ keyId: users.litellmKeyId, keyToken: users.litellmKeyToken })
    .from(users).where(eq(users.id, userId)).limit(1))[0] ?? null
}

export async function storeUserKey(userId: number, keyId: string, sealedToken: string): Promise<void> {
  await useDatabase().update(users).set({ litellmKeyId: keyId, litellmKeyToken: sealedToken }).where(eq(users.id, userId))
}

/** Every user with a key: plan facts plus the stored key (the reconcile job). */
export async function listUsersWithKeys() {
  return useDatabase().select({
    id: users.id,
    plan: users.plan,
    planValidUntil: users.planValidUntil,
    keyId: users.litellmKeyId,
    keyToken: users.litellmKeyToken
  }).from(users).where(isNotNull(users.litellmKeyId))
}

export interface StoredMemberKey {
  aiLimitUsd: number | null
  aiUnlimited: boolean
  litellmKeyId: string | null
  litellmKeyToken: string | null
}

/** A (non-guest) member's limit and team key; guests use their own budget, never the workspace's. */
export async function getStoredMemberKey(workspaceId: string, userId: number): Promise<StoredMemberKey | null> {
  return (await useDatabase()
    .select({
      aiLimitUsd: workspaceMembers.aiLimitUsd,
      aiUnlimited: workspaceMembers.aiUnlimited,
      litellmKeyId: workspaceMembers.litellmKeyId,
      litellmKeyToken: workspaceMembers.litellmKeyToken
    })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId), ne(workspaceMembers.role, 'guest')))
    .limit(1))[0] ?? null
}

/** Forget a member's key; with `onlyKeyId`, only while it is still that one. */
export async function clearMemberKey(workspaceId: string, userId: number, onlyKeyId?: string): Promise<void> {
  const conditions = [eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)]
  if (onlyKeyId !== undefined) conditions.push(eq(workspaceMembers.litellmKeyId, onlyKeyId))
  await useDatabase().update(workspaceMembers).set({ litellmKeyId: null, litellmKeyToken: null }).where(and(...conditions))
}

/** Store a member's new key unless a concurrent request stored one first; false when it lost the race. */
export async function storeMemberKeyIfAbsent(workspaceId: string, userId: number, keyId: string, sealedToken: string): Promise<boolean> {
  const stored = await useDatabase().update(workspaceMembers)
    .set({ litellmKeyId: keyId, litellmKeyToken: sealedToken })
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId), isNull(workspaceMembers.litellmKeyId)))
    .returning({ userId: workspaceMembers.userId })
  return stored.length > 0
}

/** Members of the workspace holding a team key. */
export async function listMembersWithKeys(workspaceId: string): Promise<number[]> {
  const rows = await useDatabase()
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), isNotNull(workspaceMembers.litellmKeyToken)))
  return rows.map(r => r.userId)
}

/** Every workspace key a user holds (account deletion). */
export async function listMemberKeysOfUser(userId: number) {
  return useDatabase()
    .select({ workspaceId: workspaceMembers.workspaceId, keyId: workspaceMembers.litellmKeyId, token: workspaceMembers.litellmKeyToken })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.userId, userId), isNotNull(workspaceMembers.litellmKeyToken)))
}

export async function storeWorkspaceTeamId(workspaceId: string, teamId: string): Promise<void> {
  await useDatabase().update(workspaceSubscriptions).set({ litellmTeamId: teamId }).where(eq(workspaceSubscriptions.workspaceId, workspaceId))
}
