import { z } from 'zod'
import { eq, and, isNull } from 'drizzle-orm'
import { mcpPersonalTokens } from '../../../db/schema'
import { useDatabase } from '../../../utils/database'
import { MCP_SCOPES, MAX_PATS_PER_USER, issueMcpToken, type McpScope } from '../../../utils/mcpAuth'
import { appendAuditEvent, truncateIp } from '../../../repos/audit'
import { AUDIT_MCP_TOKEN_ISSUED } from '../../../legal/auditActions'

// Issue a new MCP Personal Access Token. The plaintext is returned ONCE
// here and never reconstructed afterwards — same pattern as GitHub PATs,
// `npm token create`, etc. The list endpoint shows hashes only.
//
// `name` is a free-form label (≤80 chars). `scopes` defaults to all four
// scopes because a token without write access is useless for the headline
// MCP-from-Claude-Desktop workflow; users who want a read-only audit token
// can pass an explicit subset.

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

  // Per-user cap. Counts active tokens only (revoked rows stay for
  // audit but don't count against the cap). Race-tolerant — a
  // concurrent issue could push us 1 over, which is acceptable for
  // an anti-abuse cap (correctness ceiling is at the schema level
  // anyway: there's no DB-level UNIQUE on (userId, ...)).
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

  // Audit the issuance — security-grade event, equivalent to handing
  // out account-scoped API access. The plaintext is NEVER in the
  // metadata; only the public token id + name + granted scopes.
  // `appendAuditEvent` is fire-and-forget (swallows + Sentries on
  // failure) so a Postgres hiccup never blocks the user's response.
  const ip = getClientIp(event)
  await appendAuditEvent({
    actorUserId: userId,
    actorIp: truncateIp(ip),
    scope: 'user',
    scopeId: String(userId),
    action: AUDIT_MCP_TOKEN_ISSUED,
    metadata: { tokenId: issued.tokenId, name, scopes }
  })

  // The plaintext is included EXACTLY ONCE in this response. The UI must
  // store / show it now or never; we have no recovery path.
  return {
    tokenId: issued.tokenId,
    name,
    scopes,
    createdAt: issued.createdAt.toISOString(),
    token: issued.plaintext
  }
})
