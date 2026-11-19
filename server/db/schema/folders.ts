// Folders: how documents are organised inside a workspace or among a user's
// personal documents. Organisation only: a folder carries no permissions,
// the workspace stays the access boundary (server/repos/folders.ts).

import { pgTable, serial, integer, text, timestamp, index, uniqueIndex, check, type AnyPgColumn } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { users } from './users'
import { workspaces } from './workspaces'

// Adjacency list: rename and move are one-row updates, a scope's whole tree
// is a few hundred rows read in one query, ancestors and subtrees come from a
// recursive CTE. Exactly one of `workspace_id` (a workspace folder) and
// `owner_id` (a personal folder) is set. A folder holds only documents of its
// own scope; the repo checks that on every move.
//
// `position` is reserved for a manual sibling order (fractional index); the
// UI sorts by name today, so it stays '' until manual ordering ships.
export const folders = pgTable('folders', {
  id: serial('id').primaryKey(),
  folderId: text('folder_id').notNull().unique(),
  workspaceId: text('workspace_id').references(() => workspaces.workspaceId, { onDelete: 'cascade' }),
  ownerId: integer('owner_id').references(() => users.id, { onDelete: 'cascade' }),
  // Deleting a folder through the app deletes its documents first
  // (`deleteFolderTree`); the cascade then removes the subfolders.
  parentId: text('parent_id').references((): AnyPgColumn => folders.folderId, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  position: text('position').notNull().default(''),
  createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, table => [
  check('ck_folders_one_scope', sql`num_nonnulls(${table.workspaceId}, ${table.ownerId}) = 1`),
  // Sibling names are unique case-insensitively within a scope.
  uniqueIndex('uq_folders_sibling_name').on(
    sql`coalesce(${table.workspaceId}, '')`,
    sql`coalesce(${table.ownerId}, 0)`,
    sql`coalesce(${table.parentId}, '')`,
    sql`lower(${table.name})`
  ),
  index('idx_folders_workspace_parent').on(table.workspaceId, table.parentId),
  index('idx_folders_owner_parent').on(table.ownerId, table.parentId),
  index('idx_folders_parent').on(table.parentId)
])
