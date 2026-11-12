// The per-document activity feed and comment threads.

import { pgTable, serial, integer, bigint, text, timestamp, primaryKey, index, uniqueIndex, jsonb, boolean } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import type { ActivityMetadata } from '~~/shared/contracts/activity'
import { users } from './users'
import { documents } from './documents'

// `metadata` carries structured detail per action — comment id + body
// preview for `comment.*`, before/after for `title.changed`, tool name +
// args preview for `ai.tool`. The UI renders human-readable strings via
// i18n at read time, so the row stays locale-agnostic. Action enum is a
// text column (not pgEnum) so adding values is TS-only — no ALTER TYPE.
export const activityLog = pgTable('activity_log', {
  id: serial('id').primaryKey(),
  docId: text('doc_id').notNull().references(() => documents.docId),
  // The user who triggered this activity (avatar lookup joins on it).
  // NULL for AI rows and anonymous edits; `set null` on user deletion
  // keeps the row.
  userId: integer('user_id').references(() => users.id, { onDelete: 'set null' }),
  userName: text('user_name'),
  action: text('action', { enum: [
    'edit',
    'join',
    'leave',
    'comment.added',
    'comment.replied',
    'comment.resolved',
    'comment.reopened',
    'comment.deleted',
    'theme.changed',
    'title.changed',
    'ai.tool',
    'restore'
  ] }).notNull(),
  wordCount: integer('word_count'),
  linesAdded: integer('lines_added'),
  linesRemoved: integer('lines_removed'),
  metadata: jsonb('metadata').$type<ActivityMetadata>(),
  // `yjs_updates` ids around the store event that produced this row: the
  // document's newest row id BEFORE the store and the id the store wrote.
  // The diff endpoint and restore replay the doc at them. Nullable: some
  // actions (e.g. metadata-only events fired ahead of the store flush)
  // have neither. No FK: rows below the history floor may be pruned
  // (`docs/restore-compacted` / `docs/diff-unavailable`).
  yjsDocIdBefore: bigint('yjs_doc_id_before', { mode: 'number' }),
  yjsDocIdAfter: bigint('yjs_doc_id_after', { mode: 'number' }),
  // Principal label for agent-driven rows: the JWT's userId verbatim when
  // non-numeric (`'ai:assistant:{aiSessionId}'` for the in-app loop,
  // `'mcp:{mcpSessionId}'` for MCP). NULL for human edits (`userId`).
  //
  // Attribution chain ActivityFeed renders:
  //   actor_principal LIKE 'ai:assistant:%'
  //     → strip prefix → ai_sessions.session_id
  //       → ai_sessions.initiator_user_id → users (the human)
  //   actor_principal LIKE 'mcp:%'
  //     → strip prefix → mcp_sessions.mcp_session_id
  //       → mcp_sessions.user_id → users (the human)
  //       → mcp_sessions.client_name (e.g. 'Claude Desktop')
  actorPrincipal: text('actor_principal'),
  // Anonymous rows only: the random per-browser-tab avatar token from the
  // presence broadcast (awareness `user.avatarSeed`, sessionStorage
  // `markoto-anon-avatar`), so the Activity Log shows the same face as
  // the presence bar. Not derived from anything about the visitor. NULL
  // for signed-in users (seeded by `user_id`) and agents.
  actorAvatarSeed: text('actor_avatar_seed'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, table => [
  index('idx_activity_doc').on(table.docId, table.createdAt),
  // Forensic "every agent row across all docs"; partial because only
  // agent rows have a principal.
  index('idx_activity_actor_principal').on(table.actorPrincipal).where(sql`actor_principal IS NOT NULL`),
  // Closes the cross-instance flush race: two sync containers flushing the same doc
  // post identical `edit` rows with the same boundary ids; this makes the
  // second INSERT a no-op (`ON CONFLICT DO NOTHING` in `appendActivity`).
  //
  // Limited to the three sync-server actions, whose `(docId,
  // yjsDocIdAfter)` is unique per flush. Comment rows legitimately share
  // a `yjsDocIdAfter` within one snapshot batch, and restore rows are
  // user-originated, so both insert unconditionally.
  uniqueIndex('uq_activity_doc_yjsafter')
    .on(table.docId, table.yjsDocIdAfter)
    .where(sql`yjs_doc_id_after IS NOT NULL AND action IN ('edit', 'title.changed', 'theme.changed')`)
])

// Postgres mirror of the doc's comment threads, for cross-doc questions
// ("comments mentioning user X") without loading every Y.Doc. Y.js is the
// source of truth; the editor sidebar reads it directly.
//
// The sync server's `onStoreDocument` hook posts a full snapshot of the
// comments Y.Array to `/api/internal/comments-snapshot`, which replaces
// the doc's rows, so the table lags by a few seconds.
//
// Replies share the table: `parentCommentId` is set for replies and null
// for thread roots.
export const documentComments = pgTable('document_comments', {
  docId: text('doc_id').notNull().references(() => documents.docId, { onDelete: 'cascade' }),
  // Y.js entry id (nanoid(12)); a reply has its own id.
  entryId: text('entry_id').notNull(),
  // NULL = thread root; otherwise the `entry_id` of the parent in the same doc.
  parentCommentId: text('parent_comment_id'),
  // Author name snapshot, as shown on the comment.
  authorId: integer('author_id').references(() => users.id, { onDelete: 'set null' }),
  authorName: text('author_name').notNull(),
  body: text('body').notNull(),
  // Y.js epoch-ms timestamps, mirrored verbatim so ordering matches the editor.
  createdAtMs: timestamp('created_at_ms', { withTimezone: true, mode: 'date' }).notNull(),
  updatedAtMs: timestamp('updated_at_ms', { withTimezone: true, mode: 'date' }).notNull(),
  resolved: boolean('resolved').notNull().default(false),
  // Always false today: resolving the anchor needs the live Y.Doc, which
  // the snapshot path doesn't have.
  orphaned: boolean('orphaned').notNull().default(false)
}, table => [
  primaryKey({ columns: [table.docId, table.entryId] }),
  index('idx_document_comments_author').on(table.authorId),
  index('idx_document_comments_updated').on(table.updatedAtMs)
])
