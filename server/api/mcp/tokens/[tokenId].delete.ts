import { eq, and, isNull } from 'drizzle-orm'
import { mcpPersonalTokens } from '../../../db/schema'
import { useDatabase } from '../../../utils/platform/database'
import { invalidateMcpPatCache } from '../../../utils/mcp/mcpAuth'
import { useMcpSessionBindings } from '../../../utils/mcp/mcpSessionBinding'
import { appendAuditEvent, truncateIp } from '../../../repos/audit'
import { AUDIT_MCP_TOKEN_REVOKED } from '../../../legal/auditActions'

// Revokes a Personal Access Token by soft-delete (`revoked_at`), keeping the row
// for audit; the verifier rejects any non-null row. 404 (not 403) for another
// user's token id so foreign rows don't leak.

export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const userId = session.user.id

  const tokenId = getRouterParam(event, 'tokenId')
  if (!tokenId) throw createError({ statusCode: 400, message: 'tokenId required' })

  const db = useDatabase()

  // Tuple-keyed update returning the hash (for cache invalidation) and `name`
  // (for a readable audit row). An already-revoked or foreign token returns no
  // rows, hence 404.
  const updated = await db.update(mcpPersonalTokens)
    .set({ revokedAt: new Date() })
    .where(and(
      eq(mcpPersonalTokens.tokenId, tokenId),
      eq(mcpPersonalTokens.userId, userId),
      isNull(mcpPersonalTokens.revokedAt)
    ))
    .returning({
      tokenHash: mcpPersonalTokens.tokenHash,
      name: mcpPersonalTokens.name
    })

  const row = updated[0]
  if (!row) {
    throw createError({ statusCode: 404, message: 'Token not found' })
  }

  await invalidateMcpPatCache(row.tokenHash)
  // Free the token's MCP session bindings and the user's session slots. Not
  // security-critical (the token no longer verifies); a Valkey error leaves
  // them to expire.
  await useMcpSessionBindings().releaseToken(tokenId, userId).catch((e: unknown) => {
    console.warn(`[mcp] releasing session bindings of a revoked token failed: ${e instanceof Error ? e.message : String(e)}`)
  })

  // Audit the revocation; never log the hash.
  const ip = getClientIp(event)
  await appendAuditEvent({
    actorUserId: userId,
    actorIp: truncateIp(ip),
    scope: 'user',
    scopeId: String(userId),
    action: AUDIT_MCP_TOKEN_REVOKED,
    metadata: { tokenId, name: row.name }
  })

  return { ok: true }
})
