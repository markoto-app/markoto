// MCP personal access tokens and sessions.

import { pgTable, serial, integer, text, timestamp, index } from 'drizzle-orm/pg-core'
import { users } from './users'

// MCP Personal Access Tokens: long-lived bearer tokens external MCP
// clients send in `Authorization: Bearer <token>` to /mcp.
//
// Stored SHA-256-hashed; the plaintext is shown once on creation. Each
// request's header is hashed and looked up against `tokenHash`; hits are
// Valkey-cached for 60s.
//
// Cascades with the user. Revocation (`revokedAt`) is a soft delete: the
// row stays for audit but the verifier rejects it. `expiresAt` is
// optional (null = no expiry).
//
// Scopes are a subset of `documents:read | documents:write |
// knowledge:read | web:fetch`; per-tool `enabled` guards in
// server/mcp/tools/*.ts check membership.
export const mcpPersonalTokens = pgTable('mcp_personal_tokens', {
  id: serial('id').primaryKey(),
  // Public handle (`mkt_pat_<nanoid>`) used in API responses and
  // DELETE /api/mcp/tokens/:tokenId; distinct from `id` so URLs don't
  // reveal row counts or creation order.
  tokenId: text('token_id').notNull().unique(),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  // User-supplied label, ≤80 chars (validated in the API).
  name: text('name').notNull(),
  // Hex SHA-256 of the plaintext `mkt_<32-char-base32>` token, which is
  // never stored or logged.
  tokenHash: text('token_hash').notNull().unique(),
  // Granted scopes; tools gate on `enabled: event => hasScope(event, '...')`.
  scopes: text('scopes').array().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  // Bumped on successful authentication, at most once a minute (Valkey)
  // to avoid hot-row contention.
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  // Soft delete; the verifier rejects any row where this is set.
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  // Null = never expires (manual revocation only).
  expiresAt: timestamp('expires_at', { withTimezone: true })
}, table => [
  // The unique `tokenHash` already indexes the verifier lookup.
  index('idx_mcp_personal_tokens_user').on(table.userId, table.createdAt.desc())
])

// MCP sessions: one row per client connection, assigned at `initialize`
// and stable across its tool calls. `activity_log` rows from MCP edits
// carry the principal `mcp:{mcpSessionId}`; this table resolves it to the
// human and the credential. Join chain:
//
//   activity_log.user_id = 'mcp:{mcpSessionId}'
//     → mcp_sessions.mcp_session_id  (strip 'mcp:' prefix)
//       → mcp_sessions.user_id       → users.id (the human)
//       → mcp_sessions.token_id      → mcp_personal_tokens (which credential)
//
// Writer: `touchMcpSession` in `server/utils/mcp/mcpAuth.ts` (MCP
// middleware): INSERT … ON CONFLICT DO UPDATE bumps `last_active_at`,
// throttled to once a minute by Valkey.
//
// user_id cascades with the user. token_id is SET NULL when the PAT is
// hard-deleted, so the session stays joinable to user_id; soft revocation
// keeps the link.
export const mcpSessions = pgTable('mcp_sessions', {
  id: serial('id').primaryKey(),
  // UUID from the `Mcp-Session-Id` response header, without the `mcp:`
  // prefix activity_log uses.
  mcpSessionId: text('mcp_session_id').notNull().unique(),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  // Which PAT minted this session (by `tokenId`, not the serial `id`).
  tokenId: text('token_id').references(() => mcpPersonalTokens.tokenId, { onDelete: 'set null' }),
  // `clientInfo.name` from the initialize call ("Claude Desktop", "Cursor").
  // NULL if that call wasn't seen: the session id only appears from the
  // second call on.
  clientName: text('client_name'),
  // User-Agent of the first request carrying the session id; not updated.
  userAgent: text('user_agent'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  // Bumped on authenticated tool calls, at most once a minute (Valkey).
  lastActiveAt: timestamp('last_active_at', { withTimezone: true }).notNull().defaultNow()
}, table => [
  index('idx_mcp_sessions_user').on(table.userId, table.lastActiveAt.desc()),
  // Every session that used a PAT (leaked-token triage).
  index('idx_mcp_sessions_token').on(table.tokenId)
])
