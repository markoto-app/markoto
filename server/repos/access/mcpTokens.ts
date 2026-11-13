import { eq } from 'drizzle-orm'
import { mcpPersonalTokens } from '../../db/schema'
import { useDatabase } from '../../db/client'

// Access bootstrap: an MCP Personal Access Token looked up by the SHA-256 of
// the presented secret. It runs before anything is proven (it is how a
// request becomes a user); only the MCP authentication module may import it.

export interface McpTokenRecord {
  tokenId: string
  userId: number
  scopes: string[]
  revokedAt: Date | null
  expiresAt: Date | null
}

export async function findMcpTokenByHash(tokenHash: string): Promise<McpTokenRecord | null> {
  return (await useDatabase().select({
    tokenId: mcpPersonalTokens.tokenId,
    userId: mcpPersonalTokens.userId,
    scopes: mcpPersonalTokens.scopes,
    revokedAt: mcpPersonalTokens.revokedAt,
    expiresAt: mcpPersonalTokens.expiresAt
  }).from(mcpPersonalTokens).where(eq(mcpPersonalTokens.tokenHash, tokenHash)).limit(1))[0] ?? null
}

/** Stamp `last_used_at` of the token with this hash (the caller throttles). */
export async function touchMcpTokenByHash(tokenHash: string): Promise<void> {
  await useDatabase().update(mcpPersonalTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(mcpPersonalTokens.tokenHash, tokenHash))
}
