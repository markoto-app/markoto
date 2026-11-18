// Documents and what hangs off one: shares with guests, view counts, saved themes, image uploads.

import { pgTable, serial, integer, bigint, text, timestamp, primaryKey, index, jsonb, boolean, date } from 'drizzle-orm/pg-core'
import { sql, type SQL } from 'drizzle-orm'
import type { DocTheme } from '~~/shared/types/theme'
import { tsvector } from './columns'
import { users } from './users'
import { workspaces } from './workspaces'
import { folders } from './folders'

export const documents = pgTable('documents', {
  id: serial('id').primaryKey(),
  docId: text('doc_id').notNull().unique(),
  ownerId: integer('owner_id').references(() => users.id),
  // Optional parent workspace, set at creation and movable via
  // PATCH /api/docs/:docId/workspace (canManageDoc on source + admin/editor
  // on target). Workspace delete cascades per doc in the app via
  // `deleteDocument()`; the `set null` FK is only a fallback.
  workspaceId: text('workspace_id').references(() => workspaces.workspaceId, { onDelete: 'set null' }),
  // The folder the document is filed in (NULL = the scope's root). Always a
  // folder of the document's own scope: its workspace, or its owner's
  // personal folders when it has no workspace (server/repos/folders.ts).
  // Moving the document to another workspace clears it. The `set null` FK is
  // a fallback; deleting a folder deletes its documents through the app.
  folderId: text('folder_id').references(() => folders.folderId, { onDelete: 'set null' }),
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
  // Share-link controls. After `share_expires_at` a public access
  // mode (open-edit / open-view / password) acts as `private` for
  // everyone but the owner and workspace members (`docStateOf`).
  // `share_no_download`: those visitors get no PDF / Markdown download and
  // no print. NULL / false = off.
  shareExpiresAt: timestamp('share_expires_at', { withTimezone: true }),
  shareNoDownload: boolean('share_no_download').notNull().default(false),
  // Set when a moderator restricts the document on an abuse report: it
  // stays private and unpublished, no access mode but `private`, no
  // password, no guest share, no web page, no move into a workspace,
  // until a platform admin lifts it. Copies made from it (duplicate,
  // workspace template) carry it, so a copy can't undo the decision.
  moderationRestrictedAt: timestamp('moderation_restricted_at', { withTimezone: true }),
  moderationReportId: text('moderation_report_id'),
  sizeBytes: integer('size_bytes').default(0),
  wordCount: integer('word_count').default(0),
  // Per-doc theme. NULL = the in-code `defaultTheme`. Mirrored to
  // ymeta.theme on the Y.Doc for live broadcast; this row is the source
  // of truth for connections that haven't synced yet.
  theme: jsonb('theme').$type<DocTheme>(),
  // One-line "what this doc is about", sent in the AI system prompt every
  // turn and shown as the subtitle on overview lists. '' = not set (the
  // UI collapses the subtitle, the prompt skips the `About:` line).
  description: text('description').notNull().default(''),
  // Writing register; resolves to a tone fragment in
  // `shared/audiences/index.ts` that is appended to the AI system prompt.
  // `casual` is the neutral default.
  audience: text('audience', {
    enum: ['technical', 'marketing', 'academic', 'casual', 'business', 'creative']
  }).notNull().default('casual'),
  // Free-form: an ISO 639-1 preset code (en/de/fr/es/ja/zh) or any
  // user-typed name ("Deutsch", "Romantsch"). Passed verbatim into the
  // system prompt. ≤50 chars.
  language: text('language').notNull().default('en'),
  // Skeleton picked at creation. Never read by the AI prompt path (the
  // title/description/audience/language fields carry the AI context) and
  // not editable afterwards. `blank` = no skeleton.
  templateId: text('template_id').notNull().default('blank'),
  // Anonymous docs only: SHA-256 of the creating browser's random
  // creator key (the httpOnly `markoto-anon-creator` cookie). Deleting
  // an ownerless doc requires presenting the matching key, so only the
  // browser that created it can delete it (others can still edit an
  // open-edit doc). NULL for owned docs and for older anonymous docs,
  // which can't be deleted anonymously (the inactive-doc sweep still
  // removes them). No PII: the key is random.
  anonCreatorKeyHash: text('anon_creator_key_hash'),
  // Anonymous docs created through the accept-terms gate
  // (server/utils/anonGate/): the Terms version the creating visitor
  // accepted (shared/legal/versions.ts TOS_VERSION at the time) and when
  // they ticked the box. NULL for owned docs (accepted at onboarding),
  // older anonymous docs, and instances with the gate off.
  anonTermsVersion: integer('anon_terms_version'),
  anonTermsAcceptedAt: timestamp('anon_terms_accepted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastActive: timestamp('last_active', { withTimezone: true }).notNull().defaultNow(),
  // When the content or the title last changed (written by the sync server
  // with the search index, and by the app's own content writers). Unlike
  // `last_active` it is not bumped by moves or settings, so "last edited"
  // sorts mean what they say.
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, table => [
  index('idx_documents_owner').on(table.ownerId),
  index('idx_documents_workspace_folder').on(table.workspaceId, table.folderId),
  index('idx_documents_owner_folder').on(table.ownerId, table.folderId),
  index('idx_documents_last_active').on(table.lastActive),
  // Admin product stats: documents created per day.
  index('idx_documents_created').on(table.createdAt),
  index('idx_documents_workspace').on(table.workspaceId)
])

// Plain-text copy of each document for search: title + Markdown body,
// written by the sync server on every store and by the app's own content
// writers (seed, duplicate, import). A separate table so the hot `documents`
// row never carries the body. `yjs_id` is the `yjs_updates` row the body
// reflects; an upsert only replaces an older one, so two sync instances
// can't put an older text back. 'simple' configuration (no stemming):
// documents are written in many languages. Anonymous documents (no owner, no
// workspace) are never indexed: nobody can search them.
export const documentSearch = pgTable('document_search', {
  docId: text('doc_id').primaryKey().references(() => documents.docId, { onDelete: 'cascade' }),
  title: text('title').notNull().default(''),
  body: text('body').notNull().default(''),
  bodyTsv: tsvector('body_tsv').generatedAlwaysAs(
    (): SQL => sql`setweight(to_tsvector('simple'::regconfig, ${documentSearch.title}), 'A') || setweight(to_tsvector('simple'::regconfig, ${documentSearch.body}), 'B')`
  ),
  yjsId: bigint('yjs_id', { mode: 'number' }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, table => [
  index('idx_document_search_tsv').using('gin', table.bodyTsv),
  index('idx_document_search_title_trgm').using('gin', table.title.op('gin_trgm_ops'))
])

// Documents shared with a workspace GUEST: the only way a guest
// reaches anything in the workspace. `edit` = editor rights on that one
// document, `view` = read-only. Removed with the document, the guest's
// membership (route code) and when the document leaves the workspace.
export const documentShares = pgTable('document_shares', {
  docId: text('doc_id').notNull().references(() => documents.docId, { onDelete: 'cascade' }),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  access: text('access', { enum: ['view', 'edit'] }).notNull(),
  grantedByUserId: integer('granted_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, table => [
  primaryKey({ columns: [table.docId, table.userId] }),
  index('idx_document_shares_user').on(table.userId)
])

// Opens of a shared document per day: pages opened by
// people other than the owner and workspace members. Aggregate counts
// only: no visitor, address or cookie is recorded.
export const documentViewDays = pgTable('document_view_days', {
  docId: text('doc_id').notNull().references(() => documents.docId, { onDelete: 'cascade' }),
  day: date('day', { mode: 'string' }).notNull(),
  opens: integer('opens').notNull().default(0)
}, table => [
  primaryKey({ columns: [table.docId, table.day] })
])

// User-saved theme presets (per user, up to 20). A workspace's
// `defaultTheme` is snapshotted into `documents.theme` at creation, so
// renaming or deleting a saved theme doesn't touch existing docs.
export const themes = pgTable('themes', {
  id: serial('id').primaryKey(),
  themeId: text('theme_id').notNull().unique(),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  // Optional one-liner shown under the name in the theme lists (built-in
  // presets carry one too). '' = none. Length capped at the API layer
  // (`SAVED_THEME_DESCRIPTION_MAX`, shared/config/savedThemes.ts).
  description: text('description').notNull().default(''),
  theme: jsonb('theme').$type<DocTheme>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, table => [
  index('idx_themes_user').on(table.userId)
])

// Image / file uploads. Inserted (unconfirmed) when the client requests a
// presigned URL; flipped to confirmed when the client posts back after the
// PUT. The orphan-cleanup plugin treats this table as the source of truth:
//   - confirmed_at null AND created_at older than 24h: abandoned; S3
//     object (if any) and row deleted.
//   - S3 objects under docs/{docId}/ with no matching s3_key and older
//     than 24h: deleted.
//   - the whole docs/{docId}/ prefix once the document is gone.
// `s3_key` is the FINAL key (`docs/{docId}/{fileId}`); the browser PUTs to
// a staging key (`docs/{docId}/staging/{fileId}`) that confirm copies from,
// so the presigned URL can never rewrite a confirmed image.
// Every row (pending or confirmed) counts against the uploader's
// `imageBytesPerUser` quota. The image GC (`server/utils/storage/imageGc.ts`)
// stamps `gc_checked_at` on every check and `unreferenced_since` when a
// confirmed image is referenced nowhere (current doc, restorable history,
// other docs, themes, comments); it deletes the image only once that has
// held for the retention window.
export const uploads = pgTable('uploads', {
  id: serial('id').primaryKey(),
  docId: text('doc_id').notNull().references(() => documents.docId),
  fileId: text('file_id').notNull(),
  uploaderId: integer('uploader_id').references(() => users.id),
  contentType: text('content_type').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  s3Key: text('s3_key').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  gcCheckedAt: timestamp('gc_checked_at', { withTimezone: true }),
  unreferencedSince: timestamp('unreferenced_since', { withTimezone: true })
}, table => [
  index('idx_uploads_doc').on(table.docId),
  index('idx_uploads_unconfirmed').on(table.confirmedAt, table.createdAt)
])
