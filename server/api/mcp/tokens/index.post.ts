import { z } from 'zod'
import { eq, and, isNull } from 'drizzle-orm'
import { mcpPersonalTokens } from '../../../db/schema'
import { useDatabase } from '../../../utils/platform/database'
import { MCP_SCOPES, MAX_PATS_PER_USER, issueMcpToken, type McpScope } from '../../../utils/mcp/mcpAuth'
import { appendAuditEvent, truncateIp } from '../../../repos/audit'
import { AUDIT_MCP_TOKEN_ISSUED } from '../../../legal/auditActions'

// Issues an MCP Personal Access Token. The plaintext is returned ONCE and
// never reconstructed; the list endpoint shows hashes only.
//
// `name` is a free-form label (<= 80 chars). `scopes` defaults to all four
// because a write-less token is useless for the MCP-from-Claude-Desktop
// workflow; a read-only audit token passes an explicit subset.

const bodySchema = z.object({
  name: z.string().min(1).max(80),
  scopes: z.array(z.enum(MCP_SCOPES)).min(1).optional()
})

export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const userId = session.user.id

  const raw = await readBody(event)
  const parsed = bodySchema.safeParse(raw)
  if (!parsed.success) {
    throw createError({
      statusCode: 400,
      message: 'Invalid token request',
      data: { code: 'mcp/invalid-token-request', issues: parsed.error.issues }
    })
  }

  const { name } = parsed.data
  const scopes: McpScope[] = parsed.data.scopes ?? [...MCP_SCOPES]

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
    throw createError({
      statusCode: 429,
      message: `You already have ${active.length} active MCP tokens (max ${MAX_PATS_PER_USER}). Revoke an existing token first.`,
      data: { code: 'mcp/too-many-tokens' }
    })
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
})
