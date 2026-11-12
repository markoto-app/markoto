import { and, asc, eq, isNotNull, ne } from 'drizzle-orm'
import { users, workspaceMembers, workspaces } from '../db/schema'
import { useDatabase } from '../db/client'
import type { SystemActor, UserScope, WorkspaceAccess } from './proofs'

// The per-member side of a Team / Business workspace's pooled AI budget:
// each member's limit and their key in the workspace's LiteLLM team, stored
// on the membership row. Guests take no seat and never use the pool.

export interface BillingMemberRow {
  userId: number
  name: string
  role: 'admin' | 'editor' | 'viewer' | 'guest'
  aiLimitUsd: number | null
  aiUnlimited: boolean
  /** The member's team key (encrypted), for their spend. */
  keyToken: string | null
}

/** The members on the workspace's budget, longest-serving first (admins' billing tab). */
export async function listBillingMembers(ws: WorkspaceAccess<'admin'>): Promise<BillingMemberRow[]> {
  return useDatabase()
    .select({
      userId: users.id,
      name: users.name,
      role: workspaceMembers.role,
      aiLimitUsd: workspaceMembers.aiLimitUsd,
      aiUnlimited: workspaceMembers.aiUnlimited,
      keyToken: workspaceMembers.litellmKeyToken
    })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(and(eq(workspaceMembers.workspaceId, ws.workspaceId), ne(workspaceMembers.role, 'guest')))
    .orderBy(asc(workspaceMembers.joinedAt))
}

/** Set a member's AI limit; false when they are no (non-guest) member of the workspace. */
export async function setMemberAiLimit(ws: WorkspaceAccess<'admin'>, userId: number, limit: { aiLimitUsd: number | null, aiUnlimited: boolean }): Promise<boolean> {
  const updated = await useDatabase().update(workspaceMembers)
    .set(limit)
    .where(and(eq(workspaceMembers.workspaceId, ws.workspaceId), eq(workspaceMembers.userId, userId), ne(workspaceMembers.role, 'guest')))
    .returning({ userId: workspaceMembers.userId })
  return updated.length > 0
}

/** The caller's own limit in a workspace they are a member of. */
export async function getOwnAiLimit(ws: WorkspaceAccess<'member'>, self: UserScope): Promise<{ aiLimitUsd: number | null, aiUnlimited: boolean } | null> {
  return (await useDatabase()
    .select({ aiLimitUsd: workspaceMembers.aiLimitUsd, aiUnlimited: workspaceMembers.aiUnlimited })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, ws.workspaceId), eq(workspaceMembers.userId, self.userId)))
    .limit(1))[0] ?? null
}

/** The workspace's name and its admins with an email address (billing notifications). Null when the workspace is gone. */
export async function getWorkspaceAdminContacts(_by: SystemActor, workspaceId: string): Promise<{ name: string, admins: Array<{ id: number, email: string, locale: string | null }> } | null> {
  const db = useDatabase()
  const ws = (await db.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.workspaceId, workspaceId)).limit(1))[0]
  if (!ws) return null
  const admins = await db
    .select({ id: users.id, email: users.email, locale: users.locale })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.role, 'admin'), isNotNull(users.email)))
  return { name: ws.name, admins: admins.flatMap(a => a.email ? [{ id: a.id, email: a.email, locale: a.locale }] : []) }
}
