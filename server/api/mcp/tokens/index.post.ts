import { eq, and, isNull } from 'drizzle-orm'
import { mcpPersonalTokens } from '../../../db/schema'
import { useDatabase } from '../../../utils/platform/database'
import { MAX_PATS_PER_USER, issueMcpToken } from '../../../utils/mcp/mcpAuth'
import { appendAuditEvent, truncateIp } from '../../../repos/audit'
import { AUDIT_MCP_TOKEN_ISSUED } from '../../../legal/auditActions'
import { createMcpTokenBody, MCP_SCOPES, type McpScope } from '~~/shared/api/account'

// Issues an MCP Personal Access Token. The plaintext is returned ONCE and
// never reconstructed; the list endpoint shows hashes only.
//
// `name` is a free-form label (<= 80 chars). `scopes` defaults to all four
// because a write-less token is useless for the MCP-from-Claude-Desktop
// workflow; a read-only audit token passes an explicit subset.

export default defineApiHandler({
  access: allow.user(),
  body: createMcpTokenBody,
  invalidCode: 'mcp/invalid-token-request',
  handler: async ({ event, user, body }) => {
    const userId = user.id

    const { name } = body
    const scopes: McpScope[] = body.scopes ?? [...MCP_SCOPES]

    // Per-user cap on active tokens (revoked rows stay for audit but don't
    // count). Race-tolerant: a concurrent issue may overshoot by one, which is
    // fine for an anti-abuse cap.
    const db = useDatabase()
    const active = await db.select({ tokenId: mcpPersonalTokens.tokenId })
      .from(mcpPersonalTokens)
      .where(and(
        eq(mcpPersonalTokens.userId, userId),
        isNull(mcpPersonalTokens.revokedAt)
      ))
    if (active.length >= MAX_PATS_PER_USER) {
      throw apiError('mcp/too-many-tokens')
    }

    const issued = await issueMcpToken({ userId, name, scopes })

    // Audit the issuance (equivalent to handing out account-scoped API access).
    // The plaintext is NEVER in the metadata. `appendAuditEvent` is
    // fire-and-forget, so a Postgres hiccup never blocks the response.
    const ip = getClientIp(event)
    await appendAuditEvent({
      actorUserId: userId,
      actorIp: truncateIp(ip),
      scope: 'user',
      scopeId: String(userId),
      action: AUDIT_MCP_TOKEN_ISSUED,
      metadata: { tokenId: issued.tokenId, name, scopes }
    })

    // The only response that carries the plaintext; there is no recovery path.
    return {
      tokenId: issued.tokenId,
      name,
      scopes,
      createdAt: issued.createdAt.toISOString(),
      token: issued.plaintext
    }
  }
})
