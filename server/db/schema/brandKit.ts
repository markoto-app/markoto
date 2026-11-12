// Workspace brand kit (fonts, logos) and workspace templates.

import { pgTable, integer, text, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { users } from './users'
import { workspaces } from './workspaces'
import { documents } from './documents'

// Brand kit: fonts and logos uploaded by a workspace's admins. A font file is one
// family + weight + style; static TrueType outlines only (variable and
// CFF fonts print as Type 3 in Chromium's PDFs and are refused,
// server/utils/brandKit/fontInspect.ts). Bytes live in S3 at
// `workspaces/{wsId}/brand/{id}.{format}`; served per document through
// `/api/docs/:docId/brand/:file` (the renderers) and per workspace
// through `/api/workspaces/:wsId/brand/files/:file` (members' pickers).
export const workspaceBrandAssets = pgTable('workspace_brand_assets', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.workspaceId, { onDelete: 'cascade' }),
  kind: text('kind', { enum: ['font', 'image'] }).notNull(),
  format: text('format', { enum: ['woff2', 'woff', 'ttf', 'png', 'jpg', 'webp'] }).notNull(),
  // Fonts: the CSS family name documents use (unique per weight + style
  // in the workspace). Images: the display name (the uploaded file name).
  name: text('name').notNull(),
  weight: integer('weight'),
  style: text('style', { enum: ['normal', 'italic'] }),
  sizeBytes: integer('size_bytes').notNull(),
  s3Key: text('s3_key').notNull(),
  uploadedBy: integer('uploaded_by').references(() => users.id, { onDelete: 'set null' }),
  // Fonts: the uploader confirmed the workspace holds a licence that
  // allows embedding the font in documents and PDFs.
  licenceConfirmedAt: timestamp('licence_confirmed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, table => [
  index('idx_brand_assets_workspace').on(table.workspaceId),
  uniqueIndex('uq_brand_font_face').on(table.workspaceId, table.name, table.weight, table.style).where(sql`kind = 'font'`)
])

// Workspace templates: a LIVE link to one of the workspace's
// documents. A new document made from it copies that document's current
// text and design. Goes with the document (FK) and when the document
// leaves the workspace (route code).
export const workspaceTemplates = pgTable('workspace_templates', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.workspaceId, { onDelete: 'cascade' }),
  docId: text('doc_id').notNull().references(() => documents.docId, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, table => [
  uniqueIndex('uq_workspace_template_doc').on(table.workspaceId, table.docId),
  index('idx_workspace_templates_doc').on(table.docId)
])
