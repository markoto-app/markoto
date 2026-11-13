// AI sessions with their transcript and provenance, and bring-your-own-key providers.

import { pgTable, serial, integer, text, timestamp, index, uniqueIndex, jsonb, boolean } from 'drizzle-orm/pg-core'
import type { AiMessageBody } from '../columnTypes'
import { users } from './users'
import { documents } from './documents'

// Active AI sessions. Persisted so the per-user-per-doc cap survives
// restarts. Abort controllers are in-memory only.
export const aiSessions = pgTable('ai_sessions', {
  sessionId: text('session_id').primaryKey(),
  docId: text('doc_id').notNull(),
  initiatorUserId: integer('initiator_user_id').notNull().references(() => users.id),
  initiatorName: text('initiator_name').notNull(),
  initiatorColor: text('initiator_color').notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow()
}, table => [
  uniqueIndex('ai_sessions_user_doc_unq').on(table.initiatorUserId, table.docId),
  index('idx_ai_sessions_started_at').on(table.startedAt)
])

// Who an in-editor AI session (`ai:assistant:<sessionId>` in
// `activity_log.actor_principal`) wrote for, and whether its output can
// count as that person's own text. Read by the AI taint gate
// (`server/repos/docProvenance.ts`): an AI edit is the invoker's own only
// when `clean` is true. A row starts `clean = false` when the session is
// claimed and is flipped to true only after the session ended without
// ever reading content written by somebody else (`crossBoundary.ts`),
// a crash, an error before the flag is written, or a tainted session all
// leave it false, so its edits stay "foreign". Unlike `ai_sessions`
// (deleted at session end) and `ai_session_messages` (90-day retention)
// this row lives as long as the document's edit history does.
export const aiSessionProvenance = pgTable('ai_session_provenance', {
  sessionId: text('session_id').primaryKey(),
  docId: text('doc_id').notNull().references(() => documents.docId, { onDelete: 'cascade' }),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  clean: boolean('clean').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, table => [
  // Data export + account-deletion lookups by user.
  index('idx_ai_session_provenance_user').on(table.userId)
])

// Per-(doc, user) memory for the AI loop, so a follow-up prompt can
// resolve "it" / "that table" across separate /api/ai/prompt requests.
//
// Compaction (`server/utils/agentic/conversationMemory.ts`):
//   - user_prompt / message_to_user: body verbatim.
//   - tool_call: tool NAME + a short arg summary only. Results are never
//     stored; the model re-issues the call if it needs them.
//
// Cascades with the doc, and with the user: rows hold literal prompts, so
// they are deleted on account deletion rather than anonymised.
export const aiSessionMessages = pgTable('ai_session_messages', {
  id: serial('id').primaryKey(),
  docId: text('doc_id').notNull().references(() => documents.docId, { onDelete: 'cascade' }),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  // The AI session that produced this row. Not a FK: ai_sessions rows are
  // pruned at session end while memory persists.
  sessionId: text('session_id').notNull(),
  kind: text('kind', { enum: ['user_prompt', 'tool_call', 'message_to_user'] }).notNull(),
  // Shape varies by kind:
  //   user_prompt:      { text }
  //   tool_call:        { name, summary }
  //   message_to_user:  { message, isQuestion }
  body: jsonb('body').$type<AiMessageBody>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, table => [
  // Hot path: this user's recent memory for this doc.
  index('idx_ai_msg_doc_user_time').on(table.docId, table.userId, table.createdAt)
])

// Bring-your-own-key AI provider configs. One row per user per
// capability (`chat` | `image` | `transcription`). Every LLM call for
// that capability is routed through LiteLLM's zero-cost `byok/*`
// deployment with these values as clientside credentials, so the
// user's own provider account pays and the platform AI budget is not
// touched. See `server/utils/aiProviders/` + docs/AI-MODELS.md.
//
//   - `api_key_encrypted` uses the same AES-256-GCM scheme as the
//     LiteLLM virtual-key tokens (`server/utils/platform/secretBox.ts`,
//     own HKDF key from NUXT_ENCRYPTION_KEY, bound to user + capability). The plaintext is never returned to
//     the client, never logged and never included in the data export;
//     `api_key_last4` is what the UI shows.
//   - `base_url` is validated against the BYOK URL policy at save time
//     AND re-validated on every request (DNS can change).
//   - `supports_tools` / `last_verified_at` record the last verification
//     probe (chat: a tool-call round trip at temperature 0).
//   - CASCADE on the user FK: account deletion removes the rows.
export const userAiProviders = pgTable('user_ai_providers', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  capability: text('capability', { enum: ['chat', 'image', 'transcription'] }).notNull(),
  baseUrl: text('base_url').notNull(),
  model: text('model').notNull(),
  apiKeyEncrypted: text('api_key_encrypted').notNull(),
  apiKeyLast4: text('api_key_last4').notNull(),
  supportsVision: boolean('supports_vision').notNull().default(false),
  supportsTools: boolean('supports_tools'),
  lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, table => [
  uniqueIndex('uq_user_ai_providers_user_capability').on(table.userId, table.capability)
])
