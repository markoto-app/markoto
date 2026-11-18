// AI sessions with their transcript and provenance, and bring-your-own-key providers.

import { pgTable, serial, integer, text, timestamp, index, uniqueIndex, jsonb, boolean, date, doublePrecision, primaryKey } from 'drizzle-orm/pg-core'
import type { AiJobEstimate, AiJobParams, AiJobUnitOutput, AiMessageBody } from '../columnTypes'
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
//   - `fast_model` (chat only): an optional second model id on the same
//     base URL + key, the worker model for large delegated edits and the
//     fetch_url / web_search synthesis. Null = the chat model.
//   - CASCADE on the user FK: account deletion removes the rows.
export const userAiProviders = pgTable('user_ai_providers', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  capability: text('capability', { enum: ['chat', 'image', 'transcription'] }).notNull(),
  baseUrl: text('base_url').notNull(),
  model: text('model').notNull(),
  fastModel: text('fast_model'),
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

// Daily AI cost rollup, without any user or document identifier: per UTC
// day, feature tag and model, the cost, the request count and how many
// distinct users made calls. Filled from LiteLLM's spend logs by
// `ai-spend-rollup` while the raw rows still exist (they are deleted after
// 90 days by `spend-logs-sweep`), so the admin's AI cost history outlives
// them. Kept indefinitely: it holds no personal data.
export const aiSpendDaily = pgTable('ai_spend_daily', {
  day: date('day', { mode: 'string' }).notNull(),
  // A `feature:*` tag, or 'other' for calls without one.
  feature: text('feature').notNull(),
  model: text('model').notNull(),
  // False for calls on a user's own key (`byok/*`, logged at zero cost).
  platformPaid: boolean('platform_paid').notNull(),
  spendUsd: doublePrecision('spend_usd').notNull(),
  requests: integer('requests').notNull(),
  users: integer('users').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, table => [
  primaryKey({ columns: [table.day, table.feature, table.model, table.platformPaid] })
])

// Delegated large-scale edits ("jobs"): the planner splits a document into
// units, worker-model calls transform each unit, the server applies the
// results (`server/utils/ai/jobs/`). A job outlives the AI session that
// started it, so its state is here: status, counters, cost, and per unit
// the Y.js positions, the revision hash and the text before the change
// (for "Undo job"). The before texts are document content: purged 7 days
// after the job started (`ai-jobs-sweep`), cascade with the document, and
// with the initiator (account deletion), whose instructions the row holds.
// Finished job rows themselves follow the AI records retention (90 days).
export const AI_JOB_STATUSES = ['preview', 'awaiting_confirmation', 'running', 'paused_budget', 'cancelled', 'interrupted', 'done', 'failed', 'stopped_access', 'reverted'] as const
export const AI_JOB_MODES = ['rewrite', 'translate', 'terminology', 'summarise', 'comment', 'scan'] as const
export const AI_JOB_UNIT_STATUSES = ['pending', 'running', 'applied', 'skipped', 'flagged', 'failed', 'reverted'] as const

export const aiJobs = pgTable('ai_jobs', {
  id: text('id').primaryKey(),
  docId: text('doc_id').notNull().references(() => documents.docId, { onDelete: 'cascade' }),
  initiatorUserId: integer('initiator_user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  // The document's workspace when the job started (spend tags, audit); not a FK.
  workspaceId: text('workspace_id'),
  // The AI session that started the job (not a FK: sessions are pruned at their end).
  sessionId: text('session_id'),
  mode: text('mode', { enum: AI_JOB_MODES }).notNull(),
  status: text('status', { enum: AI_JOB_STATUSES }).notNull().default('preview'),
  params: jsonb('params').$type<AiJobParams>().notNull(),
  estimate: jsonb('estimate').$type<AiJobEstimate>(),
  // USD on the platform budget; `cost_known = false` for a user's own key without a known price.
  costUsd: doublePrecision('cost_usd').notNull().default(0),
  costKnown: boolean('cost_known').notNull().default(true),
  tokensIn: integer('tokens_in').notNull().default(0),
  tokensOut: integer('tokens_out').notNull().default(0),
  unitsTotal: integer('units_total').notNull().default(0),
  unitsDone: integer('units_done').notNull().default(0),
  unitsSkipped: integer('units_skipped').notNull().default(0),
  unitsFlagged: integer('units_flagged').notNull().default(0),
  unitsRetried: integer('units_retried').notNull().default(0),
  workerModel: text('worker_model'),
  // Why the job stopped (failed / stopped_access / paused_budget): a fixed sentence, never upstream text.
  reason: text('reason'),
  currentHeading: text('current_heading'),
  // Updated by the running instance; the sweeper marks a `running` job with a stale heartbeat `interrupted`.
  heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true })
}, table => [
  index('idx_ai_jobs_doc_created').on(table.docId, table.createdAt),
  index('idx_ai_jobs_user_created').on(table.initiatorUserId, table.createdAt),
  index('idx_ai_jobs_status_heartbeat').on(table.status, table.heartbeatAt)
])

export const aiJobUnits = pgTable('ai_job_units', {
  jobId: text('job_id').notNull().references(() => aiJobs.id, { onDelete: 'cascade' }),
  ordinal: integer('ordinal').notNull(),
  headingPath: text('heading_path').notNull(),
  // Y.RelativePosition of the unit's start / end (`Y.encodeRelativePosition`, base64).
  startRel: text('start_rel').notNull(),
  endRel: text('end_rel').notNull(),
  // Hash of the unit text at job start; a different current hash means someone else edited it.
  revBefore: text('rev_before').notNull(),
  unitTokens: integer('unit_tokens').notNull().default(0),
  status: text('status', { enum: AI_JOB_UNIT_STATUSES }).notNull().default('pending'),
  // Why the unit was skipped / flagged / failed (fixed sentences and validator messages).
  reason: text('reason'),
  attempts: integer('attempts').notNull().default(0),
  // The unit's text before the job changed it (undo, glossary check); null after the 7-day purge.
  beforeText: text('before_text'),
  // Hash of the text the job wrote; undo restores only while the current text still has it.
  afterHash: text('after_hash'),
  // Comment / scan results and preview samples: JSON, never applied to the document by the engine.
  output: jsonb('output').$type<AiJobUnitOutput>(),
  costUsd: doublePrecision('cost_usd').notNull().default(0),
  tokensIn: integer('tokens_in').notNull().default(0),
  tokensOut: integer('tokens_out').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, table => [
  primaryKey({ columns: [table.jobId, table.ordinal] }),
  index('idx_ai_job_units_job_status').on(table.jobId, table.status, table.ordinal)
])
