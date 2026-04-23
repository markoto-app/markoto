import { pgTable, serial, integer, text, timestamp, primaryKey, index, uniqueIndex, jsonb, vector, customType } from 'drizzle-orm/pg-core'
import { sql, type SQL } from 'drizzle-orm'
import type { DocTheme } from '~~/shared/types/theme'

// Postgres `tsvector` — drizzle doesn't ship a native type for it, but
// generated columns + the usual operators work fine via customType. We
// use STORED generation (the drizzle default) so the vector is computed
// at write time and the GIN index stays in sync without triggers.
const tsvector = customType<{ data: string }>({
  dataType() { return 'tsvector' }
})

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  githubId: text('github_id').unique(),
  googleId: text('google_id').unique(),
  login: text('login'),
  name: text('name').notNull(),
  email: text('email'),
  avatarUrl: text('avatar_url'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
})

export const documents = pgTable('documents', {
  id: serial('id').primaryKey(),
  docId: text('doc_id').notNull().unique(),
  ownerId: integer('owner_id').references(() => users.id),
  // Optional parent workspace. Folder-like containment: set at creation
  // and moveable afterwards via PATCH /api/docs/:docId/workspace
  // (authz: canManageDoc on source + admin/editor on target).
  // Workspace delete cascades at the app layer via `deleteDocument()`
  // per-doc — FK kept at `set null` as a defensive fallback if a row
  // survives the cascade.
  workspaceId: text('workspace_id').references(() => workspaces.workspaceId, { onDelete: 'set null' }),
  title: text('title').notNull().default('Untitled'),
  // `private` = owner-only (default for logged-in users on creation).
  // `open-edit` = anyone with the link can edit (default for anonymous creation,
  //                since otherwise the anonymous creator locks themselves out).
  // `open-view` = anyone can view; only the owner can edit.
  // `password-protected` = view/edit gated by a shared password.
  accessMode: text('access_mode', {
    enum: ['private', 'open-edit', 'open-view', 'password-protected']
  }).notNull().default('open-edit'),
  passwordHash: text('password_hash'),
  sizeBytes: integer('size_bytes').default(0),
  wordCount: integer('word_count').default(0),
  // Per-doc theme (page size, fonts, colors, headers/footers, etc).
  // NULL = use the in-code `defaultTheme`. Mirrored to ymeta.theme on the
  // Y.Doc so changes broadcast live to every connected client; the DB row
  // is the source of truth for new connections that haven't synced yet.
  theme: jsonb('theme').$type<DocTheme>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastActive: timestamp('last_active', { withTimezone: true }).notNull().defaultNow()
}, table => [
  index('idx_documents_owner').on(table.ownerId),
  index('idx_documents_last_active').on(table.lastActive),
  index('idx_documents_workspace').on(table.workspaceId)
])

export const workspaces = pgTable('workspaces', {
  id: serial('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().unique(),
  // Immutable "original creator" field. Authorization goes through
  // `workspace_members.role` — ownerId is for record-keeping only (e.g.
  // "who invited everyone here"). Promoting/demoting admins never touches
  // this row; deleting the creator's account would need separate handling.
  ownerId: integer('owner_id').notNull().references(() => users.id),
  name: text('name').notNull().default('My Workspace'),
  description: text('description'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, table => [
  index('idx_workspaces_owner').on(table.ownerId)
])

// Membership + role table. Single source of truth for "who can do what" in
// a workspace. The creator always has a row here with role='admin' (inserted
// on workspace creation). FK cascades keep membership in sync when the
// workspace or the user disappears.
//
// Invariant enforced at the API layer (not SQL): every workspace must have
// at least one admin. Demoting/removing the last admin is refused.
export const workspaceMembers = pgTable('workspace_members', {
  workspaceId: text('workspace_id').notNull().references(() => workspaces.workspaceId, { onDelete: 'cascade' }),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  role: text('role', { enum: ['admin', 'editor', 'viewer'] }).notNull().default('editor'),
  joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow()
}, table => [
  primaryKey({ columns: [table.workspaceId, table.userId] }),
  index('idx_workspace_members_user').on(table.userId)
])

// Active AI sessions. Survives Nitro restarts so the per-user-per-doc cap can't
// be bypassed by restarting the process. Abort controllers themselves are
// in-memory only — that's an acceptable single-process limitation for now.
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

// Image / file uploads. Inserted (unconfirmed) when the client requests a
// presigned URL; flipped to confirmed when the client posts back after the
// PUT. The orphan-cleanup plugin uses this table as the source of truth:
//   - rows with confirmed_at = null AND created_at < now - 24h → abandoned;
//     S3 object (if any) deleted, row dropped.
//   - S3 objects under docs/{docId}/ with no matching s3_key in uploads
//     AND last-modified > 24h → defensive cleanup.
//   - whole prefix docs/{docId}/ when the parent document is gone → cascade.
export const uploads = pgTable('uploads', {
  id: serial('id').primaryKey(),
  docId: text('doc_id').notNull().references(() => documents.docId),
  fileId: text('file_id').notNull(),
  uploaderId: integer('uploader_id').references(() => users.id),
  contentType: text('content_type').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  s3Key: text('s3_key').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true })
}, table => [
  index('idx_uploads_doc').on(table.docId),
  index('idx_uploads_unconfirmed').on(table.confirmedAt, table.createdAt)
])

// Workspace-level knowledge base. Files (PDFs, DOCX, PPTX, etc.) that
// workspace members upload so the AI assistant can retrieve grounded
// content when writing in any doc under that workspace. Ingest pipeline:
// S3 → markitdown (→ markdown) → chunker → gemini-embedding-2-preview
// (768-dim via MRL) → chunks table. Vector search + full-text retrieval
// is exposed to the AI via `search_knowledge` and `get_knowledge_file`
// tools.
//
// Cascades: workspace delete drops rows via FK; per-row delete also
// tears down chunks via chunks' FK cascade AND the original S3 object.
export const workspaceKnowledge = pgTable('workspace_knowledge', {
  id: serial('id').primaryKey(),
  knowledgeId: text('knowledge_id').notNull().unique(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.workspaceId, { onDelete: 'cascade' }),
  // Display name. Collisions are resolved with a numeric suffix
  // (`report.pdf`, `report (2).pdf`) at confirm time — see duplicate
  // handling in the knowledge repo.
  filename: text('filename').notNull(),
  // Extension hint routed to markitdown (pdf, docx, pptx, xlsx, html, epub, …).
  sourceExt: text('source_ext').notNull(),
  mimeType: text('mime_type').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  // S3 key of the original uploaded file. Shape: `workspaces/{wsId}/knowledge/{kId}.{ext}`.
  s3Key: text('s3_key').notNull().unique(),
  // Parsed markdown, cached so `get_knowledge_file` returns instantly.
  // Populated by the processing pipeline once markitdown succeeds.
  markdownCache: text('markdown_cache'),
  status: text('status', { enum: ['processing', 'ready', 'failed'] }).notNull().default('processing'),
  errorMessage: text('error_message'),
  chunkCount: integer('chunk_count').notNull().default(0),
  tokenCount: integer('token_count').notNull().default(0),
  // String key like `gemini-embedding-2-preview:768` so we can detect
  // chunks produced with an old model/dim and re-embed lazily.
  embeddingVersion: text('embedding_version').notNull(),
  uploaderId: integer('uploader_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp('processed_at', { withTimezone: true })
}, table => [
  index('idx_wk_workspace').on(table.workspaceId),
  // Sweep stuck-processing rows older than N minutes.
  index('idx_wk_status_created').on(table.status, table.createdAt),
  // Enforce per-workspace filename uniqueness at the DB layer — the
  // confirm endpoint suffixes on collision before insert.
  uniqueIndex('wk_workspace_filename_unq').on(table.workspaceId, table.filename)
])

// Per-chunk embeddings + content for a knowledge file. One row per
// chunk; `chunkIndex` preserves ordering. `workspaceId` is denormalized
// so vector-search queries can filter by workspace without a join.
// Chunks cascade-delete with the parent knowledge row.
export const workspaceKnowledgeChunks = pgTable('workspace_knowledge_chunks', {
  id: serial('id').primaryKey(),
  knowledgeId: text('knowledge_id').notNull().references(() => workspaceKnowledge.knowledgeId, { onDelete: 'cascade' }),
  workspaceId: text('workspace_id').notNull(),
  chunkIndex: integer('chunk_index').notNull(),
  content: text('content').notNull(),
  tokens: integer('tokens').notNull(),
  // 768 dims = Gemini MRL lower tier. HNSW-compatible (pgvector caps
  // HNSW at 2000 dims, so 3072 would require IVFFlat — slower + worse
  // recall at typical corpus sizes). Plenty for doc-retrieval.
  embedding: vector('embedding', { dimensions: 768 }),
  // Generated tsvector for BM25-style full-text search. Combined with
  // the vector similarity via Reciprocal Rank Fusion in `searchKnowledge`.
  // `STORED` (drizzle default) means Postgres materializes the vector at
  // write time and the GIN index stays in sync without triggers.
  contentTsv: tsvector('content_tsv').generatedAlwaysAs(
    (): SQL => sql`to_tsvector('english', ${workspaceKnowledgeChunks.content})`
  ),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, table => [
  index('idx_wkc_knowledge').on(table.knowledgeId),
  index('idx_wkc_workspace').on(table.workspaceId),
  index('idx_wkc_embedding').using('hnsw', table.embedding.op('vector_cosine_ops')),
  index('idx_wkc_content_tsv').using('gin', table.contentTsv)
])

export const activityLog = pgTable('activity_log', {
  id: serial('id').primaryKey(),
  docId: text('doc_id').notNull().references(() => documents.docId),
  userName: text('user_name'),
  action: text('action', { enum: ['edit', 'join', 'leave'] }).notNull(),
  wordCount: integer('word_count'),
  linesAdded: integer('lines_added'),
  linesRemoved: integer('lines_removed'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, table => [
  index('idx_activity_doc').on(table.docId, table.createdAt)
])
