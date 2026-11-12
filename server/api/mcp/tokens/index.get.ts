import { listActiveMcpTokens } from '../../../repos/mcpTokens'

// Lists the caller's MCP Personal Access Tokens: metadata only (plaintext is
// never reconstructed), revoked tokens excluded.

export default defineApiHandler({
  access: allow.user(),
  handler: async ({ self }) => {
    const rows = await listActiveMcpTokens(self)

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
