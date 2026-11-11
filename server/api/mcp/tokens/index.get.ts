import { eq, desc, and, isNull } from 'drizzle-orm'
import { mcpPersonalTokens } from '../../../db/schema'
import { useDatabase } from '../../../utils/platform/database'

// Lists the caller's MCP Personal Access Tokens: metadata only (plaintext is
// never reconstructed), revoked tokens excluded.

export default defineApiHandler({
  access: allow.user(),
  handler: async ({ user }) => {
    const db = useDatabase()
    const rows = await db.select({
      tokenId: mcpPersonalTokens.tokenId,
      name: mcpPersonalTokens.name,
      scopes: mcpPersonalTokens.scopes,
      createdAt: mcpPersonalTokens.createdAt,
      lastUsedAt: mcpPersonalTokens.lastUsedAt,
      expiresAt: mcpPersonalTokens.expiresAt
    })
      .from(mcpPersonalTokens)
      .where(and(
        eq(mcpPersonalTokens.userId, user.id),
        isNull(mcpPersonalTokens.revokedAt)
      ))
      .orderBy(desc(mcpPersonalTokens.createdAt))

    return rows.map(r => ({
      tokenId: r.tokenId,
      name: r.name,
      scopes: r.scopes,
      createdAt: r.createdAt.toISOString(),
      lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
      expiresAt: r.expiresAt?.toISOString() ?? null
    }))
  }
})
