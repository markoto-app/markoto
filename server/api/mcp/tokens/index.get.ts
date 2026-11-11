import { eq, desc, and, isNull } from 'drizzle-orm'
import { mcpPersonalTokens } from '../../../db/schema'
import { useDatabase } from '../../../utils/platform/database'

// List the caller's MCP Personal Access Tokens. Plaintext is never
// reconstructed — the response carries metadata only. Revoked tokens
// are excluded; the user only sees actionable rows.

export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const userId = session.user.id

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
      eq(mcpPersonalTokens.userId, userId),
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
})
