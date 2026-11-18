// Bulk import jobs (files, folders, zip archives, public GitHub repositories)
// and their files. Processed by the import worker (server/utils/imports/).

import { pgTable, serial, integer, bigint, text, timestamp, index, uniqueIndex, boolean } from 'drizzle-orm/pg-core'
import {
  IMPORT_ITEM_KINDS,
  IMPORT_ITEM_REASONS,
  IMPORT_ITEM_STATUSES,
  IMPORT_JOB_SOURCES,
  IMPORT_JOB_STATUSES
} from '~~/shared/config/imports'
import { users } from './users'
import { workspaces } from './workspaces'
import { folders } from './folders'
import { documents } from './documents'

// One import the user started. The worker claims `queued` jobs with
// `FOR UPDATE SKIP LOCKED` and stamps `heartbeat_at` while it runs; a running
// job whose heartbeat is stale lost its instance and is queued again (items
// are idempotent: a finished item keeps its document). `cancel_requested` is
// checked between items. Rows are deleted 30 days after they finish
// (`import-sweep`), with the user (cascade) and with the workspace.
export const importJobs = pgTable('import_jobs', {
  id: serial('id').primaryKey(),
  jobId: text('job_id').notNull().unique(),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  // NULL = into the user's personal documents.
  workspaceId: text('workspace_id').references(() => workspaces.workspaceId, { onDelete: 'cascade' }),
  // NULL = the scope's root. Set null if the folder is deleted meanwhile.
  targetFolderId: text('target_folder_id').references(() => folders.folderId, { onDelete: 'set null' }),
  source: text('source', { enum: IMPORT_JOB_SOURCES }).notNull(),
  // GitHub: the repository URL the user gave (never a token). NULL for uploads.
  sourceRef: text('source_ref'),
  status: text('status', { enum: IMPORT_JOB_STATUSES }).notNull().default('uploading'),
  cancelRequested: boolean('cancel_requested').notNull().default(false),
  // Counters the dialog polls: files that become documents, and how they ended.
  total: integer('total').notNull().default(0),
  done: integer('done').notNull().default(0),
  failed: integer('failed').notNull().default(0),
  skipped: integer('skipped').notNull().default(0),
  // Declared size of the uploaded files (the plan cap is checked against it
  // before anything is uploaded; the worker re-checks what it reads).
  totalBytes: bigint('total_bytes', { mode: 'number' }).notNull().default(0),
  // Why the whole job failed: a fixed code (`imports.jobError.<code>`).
  error: text('error'),
  heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true })
}, table => [
  index('idx_import_jobs_user_created').on(table.userId, table.createdAt),
  index('idx_import_jobs_status').on(table.status, table.heartbeatAt),
  index('idx_import_jobs_workspace').on(table.workspaceId, table.createdAt)
])

// One file of a job. Uploaded files are put by the browser to the staging key
// `imports/{jobId}/{itemId}` (presigned, read and deleted by the worker);
// files from an archive or a repository are created by the worker with
// `s3_key` NULL. `relative_path` is the normalised path inside the upload,
// which the worker mirrors as folders.
export const importJobItems = pgTable('import_job_items', {
  id: serial('id').primaryKey(),
  jobId: text('job_id').notNull().references(() => importJobs.jobId, { onDelete: 'cascade' }),
  itemId: text('item_id').notNull(),
  relativePath: text('relative_path').notNull(),
  kind: text('kind', { enum: IMPORT_ITEM_KINDS }).notNull(),
  status: text('status', { enum: IMPORT_ITEM_STATUSES }).notNull().default('pending'),
  reason: text('reason', { enum: IMPORT_ITEM_REASONS }),
  // The id the item's document gets, chosen when the job starts so links
  // between imported files can be rewritten before the documents exist.
  plannedDocId: text('planned_doc_id'),
  docId: text('doc_id').references(() => documents.docId, { onDelete: 'set null' }),
  s3Key: text('s3_key'),
  sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull().default(0),
  // Images found in the file that could not be stored (missing, unsupported, over quota).
  imagesSkipped: integer('images_skipped').notNull().default(0)
}, table => [
  uniqueIndex('uq_import_job_items_item').on(table.jobId, table.itemId),
  index('idx_import_job_items_job_status').on(table.jobId, table.status)
])
