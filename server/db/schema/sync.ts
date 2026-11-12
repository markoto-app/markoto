// The Y.js update log of each document, written by the sync server.

import { pgTable, bigint, text, timestamp, index } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { bytea } from './columns'
import { documents } from './documents'

// A document's Y.js state as an append-only log (written by the sync server,
// read by history replay, duplicate, render, export and the image GC).
//
// - `update`: a Y.js update, what one store added since the previous store of
//   the same sync server process (the full delete set included).
// - `snapshot`: the merged state of EVERY row of the document with a smaller
//   id. Its data is redundant; it only spares readers the replay of the rows
//   below it, and it is what lets older rows be pruned.
//
// The state at id X is all rows with id <= X applied, which equals the newest
// snapshot <= X plus the updates after it. Every writer holds the per-document
// transaction lock (`pg_advisory_xact_lock(YJS_LOCK_NAMESPACE, hashtext(doc_id))`)
// while it inserts, so within one document the id order is the commit order:
// an id read once can never later gain a smaller sibling, which is what
// `activity_log.yjs_doc_id_*` and the snapshot invariant rely on.
//
// Readers and writers: `sync-server/src/yjs-store.ts` (load, store, snapshot,
// prune) and `server/utils/documents/yjsLog.ts` (everything the app does).
// `ON DELETE CASCADE`: deleting a document deletes its Y.js state with it.
export const yjsUpdates = pgTable('yjs_updates', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  docId: text('doc_id').notNull().references(() => documents.docId, { onDelete: 'cascade' }),
  kind: text('kind', { enum: ['update', 'snapshot'] }).notNull(),
  data: bytea('data').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, table => [
  index('idx_yjs_updates_doc').on(table.docId, table.id),
  index('idx_yjs_updates_snapshots').on(table.docId, table.id).where(sql`kind = 'snapshot'`),
  // Pruning looks for snapshots older than the retention window.
  index('idx_yjs_updates_snapshot_age').on(table.createdAt).where(sql`kind = 'snapshot'`)
])
