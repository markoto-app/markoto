import { and, desc, eq, isNull, lt, sql } from 'drizzle-orm'
import { mcpPersonalTokens, mcpSessions } from '../db/schema'
import { useDatabase } from '../db/client'
import type { SystemActor, UserScope } from './proofs'

// A user's MCP Personal Access Tokens (hashes only; the plaintext is shown
// once and never stored) and the forensic `mcp_sessions` rows. Token rows
// are keyed on the proof's user: another user's token id matches nothing.
// The lookup by hash during authentication is `access/mcpTokens.ts`.

export async function insertMcpToken(self: UserScope, row: {
  tokenId: string
  name: string
  tokenHash: string
  scopes: string[]
  expiresAt: Date | null
}): Promise<{ tokenId: string, createdAt: Date } | null> {
  return (await useDatabase().insert(mcpPersonalTokens).values({ ...row, userId: self.userId }).returning({
    tokenId: mcpPersonalTokens.tokenId,
    createdAt: mcpPersonalTokens.createdAt
  }))[0] ?? null
}

/** The user's tokens that are not revoked, newest first. */
export async function listActiveMcpTokens(self: UserScope) {
  return useDatabase().select({
    tokenId: mcpPersonalTokens.tokenId,
    name: mcpPersonalTokens.name,
    scopes: mcpPersonalTokens.scopes,
    createdAt: mcpPersonalTokens.createdAt,
    lastUsedAt: mcpPersonalTokens.lastUsedAt,
    expiresAt: mcpPersonalTokens.expiresAt
  })
    .from(mcpPersonalTokens)
    .where(and(eq(mcpPersonalTokens.userId, self.userId), isNull(mcpPersonalTokens.revokedAt)))
    .orderBy(desc(mcpPersonalTokens.createdAt))
}

export async function countActiveMcpTokens(self: UserScope): Promise<number> {
  const rows = await useDatabase().select({ n: sql<number>`count(*)::int` })
    .from(mcpPersonalTokens)
    .where(and(eq(mcpPersonalTokens.userId, self.userId), isNull(mcpPersonalTokens.revokedAt)))
  return rows[0]?.n ?? 0
}

/**
 * Revoke one of the user's tokens. Returns its hash (cache invalidation)
 * and name (audit), or null when it is unknown, someone else's or already
 * revoked.
 */
export async function revokeMcpToken(self: UserScope, tokenId: string): Promise<{ tokenHash: string, name: string } | null> {
  return (await useDatabase().update(mcpPersonalTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(mcpPersonalTokens.tokenId, tokenId), eq(mcpPersonalTokens.userId, self.userId), isNull(mcpPersonalTokens.revokedAt)))
    .returning({ tokenHash: mcpPersonalTokens.tokenHash, name: mcpPersonalTokens.name }))[0] ?? null
}

/**
 * Record (or refresh) an MCP session of the verified token's user. Insert on
 * first sight; afterwards only `last_active_at` moves, and token, client name
 * and user agent are first-writer-wins (a real value is never overwritten
 * with NULL; the session is bound to the token that created it).
 */
export async function upsertMcpSession(self: UserScope, session: { mcpSessionId: string, tokenId: string | null, clientName: string | null, userAgent: string | null }): Promise<void> {
  await useDatabase().insert(mcpSessions)
    .values({ ...session, userId: self.userId })
    .onConflictDoUpdate({
      target: mcpSessions.mcpSessionId,
      set: {
        lastActiveAt: new Date(),
        tokenId: sql`coalesce(${mcpSessions.tokenId}, ${session.tokenId})`,
        clientName: sql`coalesce(${mcpSessions.clientName}, ${session.clientName})`,
        userAgent: sql`coalesce(${mcpSessions.userAgent}, ${session.userAgent})`
      }
    })
}

/** Sweep: drop sessions idle since `cutoff`. Returns how many. */
export async function deleteIdleMcpSessions(_by: SystemActor, cutoff: Date): Promise<number> {
  return (await useDatabase().delete(mcpSessions).where(lt(mcpSessions.lastActiveAt, cutoff)).returning({ id: mcpSessions.id })).length
}
