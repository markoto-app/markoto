import { sqliteTable, integer, text, uniqueIndex, index, primaryKey } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  githubId: text('github_id').unique(),
  googleId: text('google_id').unique(),
  login: text('login'),
  name: text('name').notNull(),
  email: text('email'),
  avatarUrl: text('avatar_url'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`)
})

export const documents = sqliteTable('documents', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  docId: text('doc_id').notNull().unique(),
  ownerId: integer('owner_id').references(() => users.id),
  title: text('title').notNull().default('Untitled'),
  accessMode: text('access_mode', { enum: ['open-edit', 'open-view', 'password-protected'] }).notNull().default('open-edit'),
  passwordHash: text('password_hash'),
  sizeBytes: integer('size_bytes').default(0),
  wordCount: integer('word_count').default(0),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  lastActive: integer('last_active', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`)
}, (table) => [
  index('idx_documents_owner').on(table.ownerId),
  index('idx_documents_last_active').on(table.lastActive)
])

export const documentShares = sqliteTable('document_shares', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  docId: text('doc_id').notNull().references(() => documents.docId),
  userId: integer('user_id').notNull().references(() => users.id),
  role: text('role', { enum: ['editor', 'viewer'] }).notNull().default('editor'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`)
}, (table) => [
  uniqueIndex('idx_share_unique').on(table.docId, table.userId)
])

export const workspaces = sqliteTable('workspaces', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  workspaceId: text('workspace_id').notNull().unique(),
  ownerId: integer('owner_id').notNull().references(() => users.id),
  name: text('name').notNull().default('My Workspace'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`)
})

export const workspaceDocuments = sqliteTable('workspace_documents', {
  workspaceId: text('workspace_id').notNull().references(() => workspaces.workspaceId),
  docId: text('doc_id').notNull().references(() => documents.docId),
  addedAt: integer('added_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`)
}, (table) => [
  primaryKey({ columns: [table.workspaceId, table.docId] })
])

export const activityLog = sqliteTable('activity_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  docId: text('doc_id').notNull().references(() => documents.docId),
  userName: text('user_name'),
  action: text('action', { enum: ['edit', 'join', 'leave'] }).notNull(),
  wordCount: integer('word_count'),
  linesAdded: integer('lines_added'),
  linesRemoved: integer('lines_removed'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`)
}, (table) => [
  index('idx_activity_doc').on(table.docId, table.createdAt)
])
