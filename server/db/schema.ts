import { pgTable, serial, integer, text, timestamp, primaryKey, index, uniqueIndex, jsonb, vector, boolean, customType } from 'drizzle-orm/pg-core'
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
  // Subscription tier. Defaults to `free`; paid tiers are set by
  // the Stripe webhook when `invoice.paid` / `subscription.updated`
  // lands. See AGENTS.md §15.
  plan: text('plan', { enum: ['free', 'pro', 'max', 'ultra'] }).notNull().default('free'),
  // Paid-tier expiry = Stripe's `current_period_end`. NULL for free
  // users (free never lapses). Set by the Stripe webhook; the
  // plan-lapse sweep flips the row back to `free` + disables any
  // `(+)` workspaces once we're past this timestamp.
  planValidUntil: timestamp('plan_valid_until', { withTimezone: true }),
  // Stripe's `current_period_start` for paid users — anchors the
  // AI-credits billing period so quota resets on the invoice day, not
  // on the 1st of the calendar month. NULL for free users (they fall
  // back to the calendar-month anchor). Updated on every `invoice.paid`.
  stripeCurrentPeriodStart: timestamp('stripe_current_period_start', { withTimezone: true }),
  stripeCustomerId: text('stripe_customer_id').unique(),
  stripeSubscriptionId: text('stripe_subscription_id').unique(),
  // Phase 6 LiteLLM virtual-key handle. ONE source of truth for the
  // user's AI budget — every billable AI call routes through
  // `useLitellmForUser(litellmKeyToken)` and LiteLLM enforces the
  // `max_budget` set at the user's plan tier. Lazy-created on first
  // AI use via `ensureUserKey(userId, plan)`; updated by Stripe
  // webhooks on plan changes.
  //
  // Token storage: encrypted at rest with `LITELLM_SALT_KEY` (already
  // provisioned for LiteLLM's internal token-table encryption). The
  // raw token only exists in memory long enough to construct the
  // OpenAI SDK client. `litellmKeyId` is the bookkeeping handle
  // (LiteLLM's internal token id) — useful for `/key/info` calls that
  // accept either the token or the id.
  litellmKeyId: text('litellm_key_id').unique(),
  litellmKeyToken: text('litellm_key_token'),
  // Platform-admin flag. Source of truth for `/admin/*` access.
  // Bootstrap: a user whose email is in `NUXT_ADMIN_USER_EMAILS` is
  // auto-promoted to is_admin=true on next OAuth login (see
  // `users` repo `upsertOAuthUser`). After that, the column is the
  // durable record — env-list changes only matter for new
  // bootstrapping users, not steady-state. Never set this for a
  // user without their explicit consent + an audit trail
  // (`admin.granted` action).
  isAdmin: boolean('is_admin').notNull().default(false),
  // User's preferred locale. Drives all transactional emails (delete
  // confirmation, export-ready, breach notification, consent-version
  // bump) and the legal-document fallback when a per-locale translation
  // is missing. Nullable on purpose: NULL means "user never explicitly
  // chose, fall back to Accept-Language at send time". Don't default to
  // 'en' — that erases the distinction between "user picked English"
  // and "we never asked".
  locale: text('locale'),
  // GDPR Article 8: minors require parental consent. We require an age
  // confirmation at signup (and re-confirmation at next login for
  // grandfathered accounts). NULL means "not yet confirmed" — login
  // interstitial forces the user through the gate. NEVER backfill this
  // to a non-null value retroactively for existing users; we never
  // asked them at signup so any default would be a legal lie.
  ageConfirmedAt: timestamp('age_confirmed_at', { withTimezone: true }),
  // GDPR Article 17: deletion requested by the user. We mark the row,
  // notify the user by email, then run a 30-day grace period during
  // which a re-login can cancel. The `accountDeletionSweep` cron picks
  // up rows past `deletionGraceUntil` and hard-deletes the user + all
  // owned content. NULL on both = account is active.
  deletionRequestedAt: timestamp('deletion_requested_at', { withTimezone: true }),
  deletionGraceUntil: timestamp('deletion_grace_until', { withTimezone: true }),
  // Acceptance state for our three customer-facing legal documents.
  // The integer is the version that was acceptable AT acceptance time
  // (matched against `shared/legal/versions.ts`); on bump, the app
  // re-prompts. The `_locale` companion records which locale the user
  // actually saw at acceptance — important if a translation later turns
  // out to have drifted from the authoritative English text. Nullable
  // because (a) existing users will be re-prompted on next login, and
  // (b) DPA only applies to workspace owners.
  tosVersionAccepted: integer('tos_version_accepted'),
  tosVersionAcceptedLocale: text('tos_version_accepted_locale'),
  privacyVersionAccepted: integer('privacy_version_accepted'),
  privacyVersionAcceptedLocale: text('privacy_version_accepted_locale'),
  dpaVersionAccepted: integer('dpa_version_accepted'),
  dpaVersionAcceptedLocale: text('dpa_version_accepted_locale'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, table => [
  // Plan-lapse sweep scans for `planValidUntil < now()` among non-free
  // users. Partial index keeps it cheap as the user table grows.
  index('idx_users_plan_valid_until').on(table.planValidUntil).where(sql`${table.planValidUntil} is not null`),
  // Account-deletion sweep scans for `deletionGraceUntil < now()`. Same
  // partial-index pattern: the column is null for the vast majority of
  // rows, so the index stays small.
  index('idx_users_deletion_grace_until').on(table.deletionGraceUntil).where(sql`${table.deletionGraceUntil} is not null`)
])

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
  // One-line "what this doc is about". Surfaced in the AI system prompt
  // every turn so the model has durable context without the user
  // re-typing it. Also shown as the subtitle on overview lists.
  // Empty string means "not set" — UI collapses the subtitle and the
  // prompt builder skips the `About:` line.
  description: text('description').notNull().default(''),
  // Closed enum of writing registers. Resolves to a curated tone prompt
  // fragment in `shared/audiences/index.ts` and is appended to the AI
  // system prompt. `casual` is the most-neutral default — picking
  // `technical` would bias every blank-dialog doc into engineering
  // tone. Text-enum (not pgEnum) so adding values is TS-only.
  audience: text('audience', {
    enum: ['technical', 'marketing', 'academic', 'casual', 'business', 'creative']
  }).notNull().default('casual'),
  // Free-form language string. Either an ISO 639-1 code from the
  // 6 curated presets (en/de/fr/es/ja/zh) OR any user-typed name
  // ("english", "Deutsch", "Romantsch"). The AI handles both —
  // we just smuggle the string into the system prompt verbatim
  // and let the model pick its output language. ≤50 chars.
  language: text('language').notNull().default('en'),
  // Provenance of the structural skeleton picked at creation time.
  // Stored for analytics + a future "regenerate skeleton" feature
  // but NEVER read by the AI prompt path (the title/description/
  // audience/language fields carry all live AI context). Not
  // editable post-creation. `blank` = no skeleton.
  templateId: text('template_id').notNull().default('blank'),
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
  // `(+)` team-billing target. NULL means "each member pays their own
  // interactions" (the default). Set by the workspace admin when they
  // toggle `(+)` on and their plan is max/ultra. `aiEnabled` is the
  // boolean twin — redundant with `billingOwnerId IS NOT NULL` but kept
  // as an explicit column so admin UI + filter queries don't need to
  // NULL-check. Plan-lapse sweep flips both back to (null, false) when
  // the billing owner's subscription expires.
  billingOwnerId: integer('billing_owner_id').references(() => users.id, { onDelete: 'set null' }),
  aiEnabled: boolean('ai_enabled').notNull().default(false),
  // Default theme applied to NEW documents created in this workspace.
  // NULL = use the markoto built-in preset (the global default). Set by
  // workspace admins via the workspace settings UI. Snapshotted at
  // creation — changing this later does NOT retheme existing docs.
  defaultTheme: jsonb('default_theme').$type<DocTheme>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, table => [
  index('idx_workspaces_owner').on(table.ownerId),
  // Billing resolver reads `(+)` state by workspace id; sweep scans by
  // billing owner. Both benefit from an index on billingOwnerId.
  index('idx_workspaces_billing_owner').on(table.billingOwnerId)
])

// User-saved theme presets. Per-user, not shared across workspaces. A
// user can save up to 20 themes (parity with the workspaces-owned cap)
// and apply them to any document they own from the theme picker.
//
// Workspace admins can pick any theme they own (built-in OR user-saved)
// as the workspace's `defaultTheme`. The default is snapshotted into
// `documents.theme` at creation time, so re-renaming or deleting a saved
// theme later doesn't ripple into already-created docs.
export const themes = pgTable('themes', {
  id: serial('id').primaryKey(),
  themeId: text('theme_id').notNull().unique(),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  theme: jsonb('theme').$type<DocTheme>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, table => [
  index('idx_themes_user').on(table.userId)
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

// Per-(doc, user) conversation memory feeding the AI agentic loop's
// short-term context. Records the FACT of past prompts + tool calls
// + AI messages so a follow-up prompt can resolve "it" / "that table"
// without losing context across separate /api/ai/prompt requests.
//
// Compaction policy lives in `server/utils/agentic/conversationMemory.ts`:
//   - kind='user_prompt' → body verbatim (small, conversational glue)
//   - kind='message_to_user' → body verbatim (the AI's user-visible reply)
//   - kind='tool_call' → body holds the tool NAME + a short arg summary
//     ONLY. Tool RESULTS are never recorded — if the model needs the
//     payload again it re-issues the call. This is the bloat-prevention
//     bet: the fact "I called search_knowledge for 'pricing model'" is
//     load-bearing, the chunks themselves are reproducible.
//
// Cascade-on-doc-delete: memory is doc-bound. Cascade-on-user-delete:
// privacy — we don't keep a user's AI conversation history past account
// deletion. Same posture as the activity log on user-delete (anonymise)
// would not apply here because the entries are PII-rich (their literal
// prompts).
export const aiSessionMessages = pgTable('ai_session_messages', {
  id: serial('id').primaryKey(),
  docId: text('doc_id').notNull().references(() => documents.docId, { onDelete: 'cascade' }),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  // The AI session that produced this row. Lets debugging correlate
  // memory entries to a specific prompt's loop. Not a FK because
  // ai_sessions rows are pruned on session-end while memory persists.
  sessionId: text('session_id').notNull(),
  kind: text('kind', { enum: ['user_prompt', 'tool_call', 'message_to_user'] }).notNull(),
  // Shape varies by kind:
  //   user_prompt:      { text }
  //   tool_call:        { name, summary }
  //   message_to_user:  { message, isQuestion }
  body: jsonb('body').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, table => [
  // The hot read path is "load this user's recent memory for this doc",
  // ordered by recency. Composite index covers it in one seek + a
  // small backwards scan.
  index('idx_ai_msg_doc_user_time').on(table.docId, table.userId, table.createdAt)
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
// S3 → markitdown (→ markdown) → chunker → LiteLLM →
// jina-embeddings-v5-text-nano (768-dim native) → chunks table. Vector
// search + full-text retrieval is exposed to the AI via
// `search_knowledge` and `get_knowledge_file` tools.
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
  // String key like `jina/jina-embeddings-v5-text-nano:768` (or the
  // legacy pre-Phase-5 `gemini-embedding-2-preview:768` shape on rows
  // produced before the migration) so we can detect chunks produced
  // with an old model/dim and re-embed lazily.
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
  // 768 dims = Jina v5-text-nano native (no MRL truncation). HNSW-
  // compatible (pgvector caps HNSW at 2000 dims, so larger embedding
  // models would require IVFFlat — slower + worse recall at typical
  // corpus sizes). Plenty for doc-retrieval.
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

// Phase 6 retired the per-period interaction counter. AI usage is now
// gated solely by per-user LiteLLM virtual-key budgets — see
// `users.litellmKeyToken` + `server/utils/litellmKeys.ts`. The single
// source of truth for "how much AI budget does this user have left" is
// LiteLLM's `/key/info` endpoint, surfaced to the UI as AI Points via
// `/api/ai/credits`.

// `metadata` carries structured detail per action — comment id + body
// preview for `comment.*`, before/after for `title.changed`, tool name +
// args preview for `ai.tool`. The UI renders human-readable strings via
// i18n at read time, so the row stays locale-agnostic. Action enum is a
// text column (not pgEnum) so adding values is TS-only — no ALTER TYPE.
export const activityLog = pgTable('activity_log', {
  id: serial('id').primaryKey(),
  docId: text('doc_id').notNull().references(() => documents.docId),
  // Optional FK to the user who triggered this activity. Drives avatar
  // lookup on the read endpoint (JOIN to users). Nullable because:
  //   - AI rows have no user (synthetic principal "AI Assistant")
  //   - Anonymous edits / pre-migration rows have no userId either
  // `set null` on user deletion preserves the historical activity row.
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
  metadata: jsonb('metadata'),
  // Boundary y-postgresql row ids around the store event that produced
  // this activity row. `before` = max yjs_documents.id captured BEFORE
  // the store; `after` = max id captured AFTER. Used by the diff
  // endpoint to reconstruct the doc state on either side and compute
  // a textual diff. Both nullable: pre-feature rows have neither, and
  // some action types (e.g. metadata-only events fired ahead of the
  // store flush) may legitimately leave them empty.
  yjsDocIdBefore: integer('yjs_doc_id_before'),
  yjsDocIdAfter: integer('yjs_doc_id_after'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, table => [
  index('idx_activity_doc').on(table.docId, table.createdAt),
  // Partial unique index that closes the cross-instance flush race
  // documented in `sync-server/AGENTS.md`. Two sync-server containers
  // can flush the same doc concurrently, both compute the same edit
  // delta against the same `sync:prev-text:{docId}` baseline, and
  // both POST identical `edit` activity rows with the same boundary
  // ids. The index makes the second INSERT a no-op via
  // `ON CONFLICT DO NOTHING` in `appendActivity`.
  //
  // Scope narrowed to the three sync-server-originated actions
  // (`edit`, `title.changed`, `theme.changed`) because those are the
  // ones whose race is real AND whose `(docId, yjsDocIdAfter)` tuple
  // is naturally unique-per-flush. Comment events legitimately share
  // a `yjsDocIdAfter` across rows in one snapshot batch (multiple
  // comment.* rows fan out from one store event), and restore rows
  // are user-originated. Both are excluded by the action filter and
  // continue to insert unconditionally.
  uniqueIndex('uq_activity_doc_yjsafter')
    .on(table.docId, table.yjsDocIdAfter)
    .where(sql`yjs_doc_id_after IS NOT NULL AND action IN ('edit', 'title.changed', 'theme.changed')`)
])

// Append-only audit log for security-sensitive operations. Distinct
// from `activity_log` (per-doc user-facing feed of edits/comments/restores)
// — `audit_log` records WHO changed access controls, deleted content, or
// touched workspace membership / billing. Different retention policy
// (no auto-prune; trail must persist), different access surface (admin /
// internal forensic tools — never user-facing).
//
// Append-only by convention: the repo exports no update or delete; the
// only legitimate way for a row to disappear is the `set null` FK on
// actor_user_id (when a user account is purged) or a manual DBA action.
//
// `actor_ip` is truncated to /24 (IPv4) or /48 (IPv6) before storage to
// honour pseudonymisation under GDPR — full IPs are never persisted.
//
// Failures to write here MUST NOT propagate into the caller. The user's
// primary action (delete, role change, etc.) has already committed by
// the time the audit row is appended; failing the request because audit
// logging is wedged would be worse than a missing audit row. The repo
// swallows + Sentry-captures.
export const auditLog = pgTable('audit_log', {
  id: serial('id').primaryKey(),
  ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
  // Who did the thing. Null for system actions (sweepers, internal).
  // `set null` so user-account deletion preserves the historical row
  // (the audit trail is more valuable than the FK).
  actorUserId: integer('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
  // Captured at action time, truncated to /24 (IPv4) / /48 (IPv6).
  // Null for server-internal actions.
  actorIp: text('actor_ip'),
  // What kind of thing was acted on. The (scope, scope_id) pair is the
  // primary cross-axis filter for the audit query UI. Text-enum (not
  // pgEnum) so adding values is TS-only.
  scope: text('scope', { enum: ['doc', 'workspace', 'user', 'billing', 'system'] }).notNull(),
  // The id of the scoped entity. Doc id (text), workspace id (text),
  // user id (number-as-text). Stored as text for uniformity across
  // scopes; the consumer interprets it per-scope.
  scopeId: text('scope_id'),
  // The action namespace + verb. Examples:
  //   'doc.deleted', 'doc.access_mode_changed', 'doc.password_set',
  //   'doc.password_removed', 'doc.workspace_moved',
  //   'workspace.member_removed', 'workspace.member_role_changed',
  //   'workspace.deleted', 'workspace.billing_owner_changed',
  //   'user.session_invalidated', 'billing.plan_changed'.
  // Always lowercase, dot-separated, namespace-first.
  action: text('action').notNull(),
  // State before the action. JSONB so we can shape per-action.
  // Example for 'doc.access_mode_changed': { accessMode: 'open-edit' }.
  // Never stores secrets — passwords are recorded as { hasPassword: bool }.
  before: jsonb('before'),
  // State after.
  after: jsonb('after'),
  // Free-form context. Examples: { reason: 'workspace_cascade' },
  // { affectedUserId: 42 }, { stripeEventId: 'evt_xxx' }.
  metadata: jsonb('metadata')
}, t => [
  // Most queries are "show me audit events for this scoped entity".
  index('idx_audit_scope').on(t.scope, t.scopeId, t.ts.desc()),
  // "Show me everything actor X did" — for investigating compromised accounts.
  index('idx_audit_actor').on(t.actorUserId, t.ts.desc())
])

// Stripe webhook event-id dedup table. Stripe redelivers webhooks on
// 5xx with exponential backoff (and at-least-once even on 2xx); the
// retry payload carries the SAME `event.id` as the original delivery.
// Naive UPSERT idempotency is fine for true replays of identical
// values, but it loses defence against:
//
//   1. Replays after concurrent state mutation (e.g. ops manually
//      flipped a row to plan='free' for a refund — a stale
//      subscription.updated redelivery clobbers the correction).
//   2. Replays after a customer cancels-then-resubscribes (an old
//      "active" event redelivered late could re-activate a cancelled
//      subscription).
//
// We INSERT into this table inside the same transaction as the user
// row update; on conflict we short-circuit with a 200 + `replayed:true`.
// Stripe replays only within ~3 days, but we keep 90 days for forensic
// "did we see this event in the suspect window?" investigations. A
// daily sweeper prunes rows older than 90d.
export const processedWebhookEvents = pgTable('processed_webhook_events', {
  // Stripe's event.id is the PK. Replays land on the same id and the
  // INSERT ... ON CONFLICT DO NOTHING short-circuits.
  eventId: text('event_id').primaryKey(),
  // What kind of event we processed — useful for ops grep without
  // joining back to Stripe's API.
  type: text('type').notNull(),
  // When we first processed it. Indexed for the aged-out cleanup
  // sweep + forensic queries.
  processedAt: timestamp('processed_at', { withTimezone: true }).notNull().defaultNow()
}, t => [
  index('idx_pwe_processed_at').on(t.processedAt)
])

// Out-of-order webhook stash. Stripe's webhook delivery is at-least-
// once and intentionally NOT ordered: subscription.* events can arrive
// BEFORE checkout.session.completed, while `users.stripe_customer_id`
// is still null. A subscription handler keying on `stripe_customer_id`
// matches zero rows and silently drops.
//
// Today this is masked because `handleCheckoutSessionCompleted` runs a
// synchronous `stripe.subscriptions.retrieve` and applies canonical
// state from the live API. If anyone removes that fetch for perf, the
// dropped event becomes a real bug. We stash unmatched subscription
// events here keyed by `customerId`; on `checkout.session.completed`
// (after the customer id is bound to the user row) we drain matching
// rows in `received_at` order and replay them, then mark
// `processed=true`.
//
// A daily sweeper prunes processed=true rows older than 7 days AND
// drops never-replayed rows older than 30 days (dead customers — the
// checkout never landed, so we'd be holding the stash forever).
export const pendingStripeEvents = pgTable('pending_stripe_events', {
  // Stripe's event.id — keeps INSERT idempotent against retries of
  // the same orphan event. PK so a redelivery of an already-stashed
  // event is a no-op.
  eventId: text('event_id').primaryKey(),
  // Customer this event belongs to. Indexed because the drain query
  // is "fetch all unprocessed rows for this customer ordered by
  // received_at".
  customerId: text('customer_id').notNull(),
  // Event type for ops grep ("how many subscription.created sit in
  // stash right now?").
  type: text('type').notNull(),
  // Full JSON payload — replayed verbatim through the dispatcher when
  // the customer binding lands.
  payload: jsonb('payload').notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  // Flipped to true once the event has been replayed against a bound
  // user row. Kept (not deleted) for a week so ops can audit what was
  // late-applied; sweeper prunes after that.
  processed: boolean('processed').notNull().default(false),
  processedAt: timestamp('processed_at', { withTimezone: true })
}, t => [
  // Drain query is "WHERE customer_id = $1 AND processed = false
  // ORDER BY received_at ASC".
  index('idx_pse_customer_unprocessed').on(t.customerId, t.processed, t.receivedAt),
  // Sweeper queries scan by received_at across all rows.
  index('idx_pse_received_at').on(t.receivedAt)
])

// Postgres mirror of the doc's comment threads. Y.js is the source of
// truth (live sync, anchor positions, reactivity). This table is a
// best-effort write-side index that lets us answer cross-doc questions
// — "comments mentioning user X", "recent comment activity in this
// workspace" — without iterating every Y.Doc on disk.
//
// Sync model: the sync server's `onStoreDocument` hook posts a full
// snapshot of the doc's comments Y.Array to `/api/internal/comments-snapshot`,
// which replaces the doc's rows. Eventually consistent — a few seconds
// of lag after a comment edit is acceptable for the use cases this
// table supports. There is no read path that anchors UX on it (the
// editor's sidebar reads Y.js directly).
//
// Replies are stored in the same table with `parentCommentId` non-null;
// thread roots have `parentCommentId = null`. Single-table simplifies
// snapshot upserts at the cost of one nullable column.
export const documentComments = pgTable('document_comments', {
  // Composite PK is (docId, commentOrReplyId) — the snapshot endpoint
  // delete-by-doc + bulk-insert pattern relies on knowing every row
  // for a given docId.
  docId: text('doc_id').notNull().references(() => documents.docId, { onDelete: 'cascade' }),
  // Y.js entry id (nanoid(12)). For replies this is the reply's own id;
  // we don't reuse comment ids across roots and replies.
  entryId: text('entry_id').notNull(),
  // NULL = thread root; set = this row is a reply, parent is the
  // matching `entry_id` row in the same docId.
  parentCommentId: text('parent_comment_id'),
  // Author identity captured at write time. Author may have left the
  // workspace since; we store the snapshot as the comment shows it.
  authorId: integer('author_id').references(() => users.id, { onDelete: 'set null' }),
  authorName: text('author_name').notNull(),
  body: text('body').notNull(),
  // Y.js epoch-ms timestamps mirrored verbatim — kept as the canonical
  // ordering signal so cross-doc queries match what the user sees.
  createdAtMs: timestamp('created_at_ms', { withTimezone: true, mode: 'date' }).notNull(),
  updatedAtMs: timestamp('updated_at_ms', { withTimezone: true, mode: 'date' }).notNull(),
  resolved: boolean('resolved').notNull().default(false),
  // Set if the Y.js anchor returned null at snapshot time. The sync
  // server doesn't compute this directly (relative-position resolution
  // requires the live Y.Doc) — fixed false for now; future work could
  // surface it for "find my orphaned threads".
  orphaned: boolean('orphaned').notNull().default(false)
}, table => [
  primaryKey({ columns: [table.docId, table.entryId] }),
  // Mention notifications: a future endpoint will scan recent rows
  // whose body matches `@[...](user:N)` for a given N.
  index('idx_document_comments_author').on(table.authorId),
  index('idx_document_comments_updated').on(table.updatedAtMs)
])

// Append-only consent ledger. GDPR Article 7(1) requires the controller
// to be able to "demonstrate that the data subject has consented" — this
// table is that proof. Each row is a single consent decision (granted
// or refused) for a single processing purpose at a point in time.
//
// Anonymous consent is supported: a logged-out visitor still needs to
// answer the cookie banner before any non-essential storage happens.
// `userId` is nullable; `anonId` is the first-party cookie that anchors
// pre-login decisions and is later linked once the user logs in (a new
// row records the link, the old anonymous rows are kept for audit).
//
// Privacy posture: full IP is never stored. `ipTruncated` follows the
// `audit_log.actor_ip` convention — /24 for IPv4, /48 for IPv6. The
// user-agent string is fingerprinting-grade so we keep only a SHA-256
// hash. Both columns are evidence that "someone with this network +
// device fingerprint consented" without storing values that could
// re-identify the subject if the table leaked.
//
// Append-only: the repo exposes no UPDATE or DELETE. Withdrawing consent
// is recorded as a NEW row with `granted=false`. The latest row per
// (subject, purpose) wins at read time.
export const consentLog = pgTable('consent_log', {
  id: serial('id').primaryKey(),
  // Logged-in subject. Nullable for anonymous (cookie-only) consent.
  // `set null` so account deletion doesn't strip the proof — the row
  // survives anonymized.
  userId: integer('user_id').references(() => users.id, { onDelete: 'set null' }),
  // First-party cookie id for anonymous tracking of consent state.
  // ALWAYS populated, even for logged-in users, so a re-prompt after
  // consent-version bump can be served before the session resolves.
  anonId: text('anon_id').notNull(),
  // The processing purpose this row decides. Text-enum (not pgEnum) so
  // we can add purposes (e.g. `marketing_email`) without a migration.
  // `essential` decisions are still recorded for completeness even
  // though they aren't togglable in the banner.
  purpose: text('purpose', {
    enum: ['essential', 'analytics', 'session_replay']
  }).notNull(),
  granted: boolean('granted').notNull(),
  // Banner version the user actually saw. Bumping `consentVersion` in
  // `shared/legal/versions.ts` invalidates prior consent: the app
  // re-prompts and a new row lands at the new version.
  version: integer('version').notNull(),
  // Locale the banner was rendered in. Important for "did the user
  // actually understand what they consented to" forensic queries if a
  // translation drifts from the authoritative English text.
  locale: text('locale').notNull(),
  // /24 (IPv4) or /48 (IPv6) — same convention as audit_log.actorIp.
  // NEVER store full IPs.
  ipTruncated: text('ip_truncated'),
  // SHA-256 of the User-Agent header. Hashed so the raw fingerprint is
  // not retained, but two consents from the same browser still match
  // for fraud / "did the same client toggle this back and forth"
  // forensic queries.
  userAgentHash: text('user_agent_hash'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, table => [
  // Hot read: "what's the latest consent state for this user, across
  // purposes". Composite (user, purpose, time) covers it.
  index('idx_consent_log_user').on(table.userId, table.purpose, table.createdAt.desc()),
  // Anonymous read path mirrors the user one.
  index('idx_consent_log_anon').on(table.anonId, table.purpose, table.createdAt.desc())
])

// DSA Article 16 notice-and-action mechanism. Anyone — logged-in or
// anonymous — can flag a public document as illegal content via
// `/legal/abuse` or the in-product "Report this document" menu item.
// We acknowledge promptly, triage, and act (or dismiss with reason).
//
// Reporter email is optional: anonymous reports are accepted (DSA does
// not require reporter identity), but acknowledgement only flows if an
// email is provided. The reporter's IP is truncated to /24 / /48 for
// the same reason as audit_log + consent_log.
//
// `docId` is nullable so platform-wide reports (e.g. "this user is
// abusing markoto across multiple docs") still have a home; the doc-
// scoped link is the common case.
export const abuseReports = pgTable('abuse_reports', {
  id: serial('id').primaryKey(),
  reportId: text('report_id').notNull().unique(),
  // Subject of the report — pure free-text. Reporters paste URLs,
  // bare doc ids, typos, "platform-wide", or whatever the moderator
  // can interpret. Deliberately NOT FK'd to documents.doc_id —
  // the report is independently meaningful (and useful as evidence)
  // even if the referenced doc never existed or has since been
  // deleted in response to the report itself.
  docId: text('doc_id'),
  // Logged-in reporter — populated when the form-submission path
  // is used. NULL for email-channel reports + for legacy rows.
  // Set null on user delete (we anonymise, don't cascade-delete
  // — the report itself is still actionable evidence even after
  // the reporter deletes their account).
  reporterUserId: integer('reporter_user_id').references(() => users.id, { onDelete: 'set null' }),
  // Optional reporter contact. Anonymous reports allowed.
  reporterEmail: text('reporter_email'),
  // Truncated reporter IP for forensic correlation only — paired with
  // user_agent_hash so we can detect a single actor flooding reports
  // without storing identifying detail.
  reporterIpTruncated: text('reporter_ip_truncated'),
  reporterUserAgentHash: text('reporter_user_agent_hash'),
  // Closed enum of report categories. Text-enum so we can add (e.g.
  // `terrorism`, `hate_speech`) without a migration. `other` is the
  // catch-all and forces a body.
  category: text('category', {
    enum: ['illegal_content', 'copyright', 'csam', 'harassment', 'spam', 'other']
  }).notNull(),
  body: text('body').notNull(),
  status: text('status', {
    enum: ['open', 'acknowledged', 'actioned', 'dismissed']
  }).notNull().default('open'),
  // Internal moderator who handled the report. `set null` to preserve
  // the audit trail when staff accounts are deactivated.
  actionedBy: integer('actioned_by').references(() => users.id, { onDelete: 'set null' }),
  // Free-form internal notes (resolution rationale, communications log).
  // Never surfaced to the reporter.
  notes: text('notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
  actionedAt: timestamp('actioned_at', { withTimezone: true })
}, table => [
  // Triage queue: open reports oldest-first.
  index('idx_abuse_reports_status').on(table.status, table.createdAt),
  // Per-doc lookup for "any open reports against this doc?".
  index('idx_abuse_reports_doc').on(table.docId)
])

// GDPR Article 20 data-portability export jobs. The user requests an
// export from `/settings/account/export`; we enqueue a row here, an
// async worker streams a ZIP to S3, the user gets an email with a
// presigned URL valid until `expiresAt`. Past expiry the sweeper
// purges both the row and the S3 blob.
//
// Hard cap: 1 active job per user (the worker checks `status IN
// ('queued', 'running')` before enqueueing). Prevents cost-amplifying
// retry loops if a malicious script POSTs `/export` repeatedly.
//
// Cascade-delete on user removal — once the account is gone, no
// remaining party has lawful basis to hold export blobs. The sweeper
// removes the S3 object as part of the user-deletion cascade in
// `accountDeletionSweep`.
export const dataExportJobs = pgTable('data_export_jobs', {
  id: serial('id').primaryKey(),
  jobId: text('job_id').notNull().unique(),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  status: text('status', {
    enum: ['queued', 'running', 'ready', 'expired', 'failed']
  }).notNull().default('queued'),
  // S3 key once the worker uploads the ZIP. Null while queued/running
  // and on failure.
  s3Key: text('s3_key'),
  // Worker-emitted error message on failure. Free-form text; surfaced
  // to the user in the export-history list ("Export failed — try again
  // or contact support").
  errorMessage: text('error_message'),
  // Bytes of the produced ZIP, captured at upload time. Null until ready.
  sizeBytes: integer('size_bytes'),
  // 7d after `ready`. The sweeper expires past this point and purges
  // the S3 object. Renewal is a fresh export job — we don't extend
  // existing exports because the underlying data may have changed.
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true })
}, table => [
  // History list: most-recent-first per user.
  index('idx_data_export_jobs_user').on(table.userId, table.createdAt.desc()),
  // Worker queue scan: oldest queued row first.
  index('idx_data_export_jobs_status').on(table.status, table.createdAt)
])
