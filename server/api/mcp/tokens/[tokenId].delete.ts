import { eq, and, isNull } from 'drizzle-orm'
import { mcpPersonalTokens } from '../../../db/schema'
import { useDatabase } from '../../../utils/platform/database'
import { invalidateMcpPatCache } from '../../../utils/mcp/mcpAuth'
import { useMcpSessionBindings } from '../../../utils/mcp/mcpSessionBinding'
import { appendAuditEvent, truncateIp } from '../../../repos/audit'
import { AUDIT_MCP_TOKEN_REVOKED } from '../../../legal/auditActions'

// Revoke a Personal Access Token. Soft-delete (sets `revoked_at`) so the
// row stays for audit; the verifier rejects any row where this is non-null.
// 404 (not 403) for another user's token id so we don't leak existence
// of foreign rows.

export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const userId = session.user.id

  const tokenId = getRouterParam(event, 'tokenId')
  if (!tokenId) throw createError({ statusCode: 400, message: 'tokenId required' })

  const db = useDatabase()

  // Tuple-keyed update + return the hash so we can invalidate the cache.
  // Revoking an already-revoked or foreign-user token returns no rows →
  // 404. Same shape as the themes delete endpoint (server/api/themes/...).
  // We also project `name` for the audit metadata so the audit row is
  // human-readable ("revoked 'Claude Desktop on laptop'").
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
  // Free the token's MCP session bindings (and the user's session slots).
  // Not load-bearing for security — the token itself no longer verifies —
  // so a Valkey error only leaves the bindings to expire on their own.
  await useMcpSessionBindings().releaseToken(tokenId, userId).catch((e: unknown) => {
    console.warn(`[mcp] releasing session bindings of a revoked token failed: ${e instanceof Error ? e.message : String(e)}`)
  })

  // Audit the revocation. Same shape as issuance — security-grade
  // event, never log the hash.
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
