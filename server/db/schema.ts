import { pgTable, serial, integer, text, timestamp, primaryKey, index, uniqueIndex } from 'drizzle-orm/pg-core'

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
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastActive: timestamp('last_active', { withTimezone: true }).notNull().defaultNow()
}, (table) => [
  index('idx_documents_owner').on(table.ownerId),
  index('idx_documents_last_active').on(table.lastActive)
])

export const documentShares = pgTable('document_shares', {
  id: serial('id').primaryKey(),
  docId: text('doc_id').notNull().references(() => documents.docId),
  userId: integer('user_id').notNull().references(() => users.id),
  role: text('role', { enum: ['editor', 'viewer'] }).notNull().default('editor'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (table) => [
  uniqueIndex('idx_share_unique').on(table.docId, table.userId)
])

export const workspaces = pgTable('workspaces', {
  id: serial('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().unique(),
  ownerId: integer('owner_id').notNull().references(() => users.id),
  name: text('name').notNull().default('My Workspace'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
})

export const workspaceDocuments = pgTable('workspace_documents', {
  workspaceId: text('workspace_id').notNull().references(() => workspaces.workspaceId),
  docId: text('doc_id').notNull().references(() => documents.docId),
  addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow()
}, (table) => [
  primaryKey({ columns: [table.workspaceId, table.docId] })
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
}, (table) => [
  uniqueIndex('ai_sessions_user_doc_unq').on(table.initiatorUserId, table.docId),
  index('idx_ai_sessions_started_at').on(table.startedAt)
])

// Rate-limit hits. One row per attempt within a window. `checkRateLimit` inserts
// one and counts rows within the window; a startup + periodic job prunes older
// rows. A single shared table across namespaces.
export const rateLimits = pgTable('rate_limits', {
  id: serial('id').primaryKey(),
  namespace: text('namespace').notNull(),
  key: text('key').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, (table) => [
  index('idx_rate_limits_lookup').on(table.namespace, table.key, table.createdAt),
  index('idx_rate_limits_cleanup').on(table.createdAt)
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
}, (table) => [
  index('idx_uploads_doc').on(table.docId),
  index('idx_uploads_unconfirmed').on(table.confirmedAt, table.createdAt)
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
}, (table) => [
  index('idx_activity_doc').on(table.docId, table.createdAt)
])
