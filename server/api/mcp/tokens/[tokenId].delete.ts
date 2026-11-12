import { revokeMcpToken } from '../../../repos/mcpTokens'
import { invalidateMcpPatCache } from '../../../utils/mcp/mcpAuth'
import { useMcpSessionBindings } from '../../../utils/mcp/mcpSessionBinding'
import { appendAuditEvent, truncateIp } from '../../../repos/audit'
import { AUDIT_MCP_TOKEN_REVOKED } from '../../../legal/auditActions'
import { mcpTokenParams } from '~~/shared/api/account'
import { useLogger } from '../../../utils/platform/logger'

const log = useLogger('mcp')

// Revokes a Personal Access Token by soft-delete (`revoked_at`), keeping the row
// for audit; the verifier rejects any non-null row. 404 (not 403) for another
// user's token id so foreign rows don't leak.

export default defineApiHandler({
  access: allow.user(),
  params: mcpTokenParams,
  handler: async ({ event, self, params }) => {
    const userId = self.userId
    const { tokenId } = params

    // Keyed on (token, user) and only while not revoked: a foreign or
    // already-revoked token returns nothing, hence 404. The hash is for cache
    // invalidation, the name for a readable audit row.
    const row = await revokeMcpToken(self, tokenId)
    if (!row) throw apiError('mcp/token-not-found')

    await invalidateMcpPatCache(row.tokenHash)
    // Free the token's MCP session bindings and the user's session slots. Not
    // security-critical (the token no longer verifies); a Valkey error leaves
    // them to expire.
    await useMcpSessionBindings().releaseToken(tokenId, userId).catch((e: unknown) => {
      log.warn('releasing session bindings of a revoked token failed', { err: e })
    })

    // Audit the revocation; never log the hash.
    const ip = getClientIp(event)
    await appendAuditEvent({
      by: self,
      actorIp: truncateIp(ip),
      scope: 'user',
      scopeId: String(userId),
      action: AUDIT_MCP_TOKEN_REVOKED,
      metadata: { tokenId, name: row.name }
    })

    return { ok: true }
  }
})
