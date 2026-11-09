import { pgTable, serial, integer, text, timestamp, primaryKey, index, uniqueIndex, jsonb, vector, boolean, customType, check } from 'drizzle-orm/pg-core'
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
  // Generic OpenID Connect identity (WP7b, self-hosted IdPs). Keyed by
  // the PAIR (issuer, subject) — `sub` is only unique per issuer, and
  // the email is never the key. Both set or both null (CHECK below).
  oidcIssuer: text('oidc_issuer'),
  oidcSubject: text('oidc_subject'),
  login: text('login'),
  name: text('name').notNull(),
  email: text('email'),
  // PERSONAL subscription tier: `free` or `pro`. Team / Business are
  // workspace subscriptions (`workspace_subscriptions`). Set by the
  // Stripe webhook when `invoice.paid` / `subscription.updated` lands.
  // The retired `max` / `ultra` values were mapped to `pro` by migration
  // 0028. See AGENTS.md §7 "Billing (Stripe + LiteLLM)" +
  // server/utils/AGENTS.md.
  plan: text('plan', { enum: ['free', 'pro'] }).notNull().default('free'),
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
  // Session revocation counter. Every sealed session cookie carries the
  // value current at sign-in (`e`); `resolveValidatedUser` rejects a
  // cookie whose `e` differs. Bumped by "log out everywhere" and by an
  // account-deletion request, which invalidates every outstanding
  // cookie at once (cookies themselves can't be recalled). Cookies from
  // before this column existed carry no `e` and count as epoch 0.
  sessionEpoch: integer('session_epoch').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, table => [
  // Plan-lapse sweep scans for `planValidUntil < now()` among non-free
  // users. Partial index keeps it cheap as the user table grows.
  index('idx_users_plan_valid_until').on(table.planValidUntil).where(sql`${table.planValidUntil} is not null`),
  // Account-deletion sweep scans for `deletionGraceUntil < now()`. Same
  // partial-index pattern: the column is null for the vast majority of
  // rows, so the index stays small.
  index('idx_users_deletion_grace_until').on(table.deletionGraceUntil).where(sql`${table.deletionGraceUntil} is not null`),
  uniqueIndex('uq_users_oidc_identity').on(table.oidcIssuer, table.oidcSubject),
  check('ck_users_oidc_identity_pair', sql`(${table.oidcIssuer} is null) = (${table.oidcSubject} is null)`)
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
  // Anonymous docs only: SHA-256 of the creating browser's random
  // creator key (the httpOnly `markoto-anon-creator` cookie). Deleting
  // an ownerless doc requires presenting the matching key, so only the
  // browser that created it can delete it (others can still edit an
  // open-edit doc). NULL for owned docs and for anonymous docs created
  // before this column existed — those can't be deleted anonymously;
  // the inactive-doc sweep still removes them. No PII: the key is a
  // random value, not tied to an identity.
  anonCreatorKeyHash: text('anon_creator_key_hash'),
  // Anonymous docs created through the accept-terms gate
  // (server/utils/anonGate/): the Terms version the creating visitor
  // accepted (shared/legal/versions.ts TOS_VERSION at the time) and when
  // they ticked the box. NULL for owned docs (accepted at onboarding) and
  // for anonymous docs created before the gate, or on an instance with
  // the gate off.
  anonTermsVersion: integer('anon_terms_version'),
  anonTermsAcceptedAt: timestamp('anon_terms_accepted_at', { withTimezone: true }),
  // Earliest time the inactive-doc sweep may delete this doc. Set by
  // migration 0024 on the anonymous docs that existed when retention went
  // from 180 to 30 days (min(now + 30 days, last_active + 180 days)), so
  // the shorter period never deletes them without a full 30-day notice
  // window. NULL = no floor (every doc created since).
  sweepNotBefore: timestamp('sweep_not_before', { withTimezone: true }),
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
  // DEPRECATED — the retired `(+)` workspace AI sponsorship (replaced by
  // Team / Business workspace subscriptions, `workspace_subscriptions`).
  // No code reads or writes them any more; they stay one release so a
  // code rollback still finds them, then a migration drops them.
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

// Team / Business subscription of a workspace (pricing plan WS2). One row
// per workspace that ever had one; Stripe drives every column through the
// webhook (WP2/WP3). `resolveWorkspacePlan` (server/utils/entitlements.ts)
// counts a row only while billing is on, `status` is live and
// `valid_until` is in the future; otherwise the workspace falls back to
// its creator's personal plan.
export const workspaceSubscriptions = pgTable('workspace_subscriptions', {
  workspaceId: text('workspace_id').primaryKey().references(() => workspaces.workspaceId, { onDelete: 'cascade' }),
  plan: text('plan', { enum: ['team', 'business'] }).notNull(),
  // Paid seats. Members + open invitations may not exceed it (WP3).
  seats: integer('seats').notNull(),
  // Stripe subscription status, verbatim (active, trialing, past_due,
  // canceled, unpaid, incomplete, incomplete_expired, paused).
  status: text('status').notNull(),
  // The member who pays and manages billing. SET NULL when their account
  // is deleted; the account-deletion flow hands the role to the
  // longest-serving workspace admin first (WP3).
  billingAdminId: integer('billing_admin_id').references(() => users.id, { onDelete: 'set null' }),
  stripeCustomerId: text('stripe_customer_id'),
  stripeSubscriptionId: text('stripe_subscription_id').unique(),
  currentPeriodStart: timestamp('current_period_start', { withTimezone: true }),
  validUntil: timestamp('valid_until', { withTimezone: true }),
  // LiteLLM team holding the workspace's pooled AI budget (WP3).
  litellmTeamId: text('litellm_team_id'),
  // Stripe customers keep one currency for life.
  currency: text('currency', { enum: ['eur', 'chf'] }).notNull().default('eur'),
  interval: text('interval', { enum: ['month', 'year'] }).notNull().default('month'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, table => [
  index('idx_workspace_subscriptions_billing_admin').on(table.billingAdminId),
  index('idx_workspace_subscriptions_customer').on(table.stripeCustomerId)
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

// Pending workspace invitations. Inviting by email no longer adds a
// member: it creates one of these rows, and only the invitee accepting
// it (in-app, matched on their verified account email, or via the
// emailed link) creates the `workspace_members` row.
//
//   - `email` is the address the admin typed, normalised (trim +
//     lower-case). Matched case-insensitively against `users.email`
//     (only verified addresses are stored there) for the in-app list.
//   - `token_hash` = SHA-256 of the single-use accept token sent by
//     email; NULL when no email was sent (email not configured). The
//     raw token only exists in the email.
//   - One open invite per (workspace, email); re-inviting refreshes it.
//   - Expired rows are deleted by the `workspace-invite-sweep`; accept /
//     decline / revoke delete the row.
//   - CASCADE with the workspace; `invited_by` SET NULL when the
//     inviter's account is deleted.
export const workspaceInvites = pgTable('workspace_invites', {
  id: serial('id').primaryKey(),
  inviteId: text('invite_id').notNull().unique(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.workspaceId, { onDelete: 'cascade' }),
  email: text('email').notNull(),
  role: text('role', { enum: ['admin', 'editor', 'viewer'] }).notNull().default('editor'),
  invitedByUserId: integer('invited_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  tokenHash: text('token_hash').unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, table => [
  uniqueIndex('uq_workspace_invites_ws_email').on(table.workspaceId, table.email),
  // Invitee lookup ("invites for my email") + account-deletion purge.
  index('idx_workspace_invites_email').on(table.email),
  // Sweeper: expired rows.
  index('idx_workspace_invites_expires').on(table.expiresAt)
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

// Who an in-editor AI session (`ai:assistant:<sessionId>` in
// `activity_log.actor_principal`) wrote for, and whether its output can
// count as that person's own text. Read by the AI taint gate
// (`server/repos/docProvenance.ts`): an AI edit is the invoker's own only
// when `clean` is true. A row starts `clean = false` when the session is
// claimed and is flipped to true only after the session ended without
// ever reading content written by somebody else (`crossBoundary.ts`) —
// a crash, an error before the flag is written, or a tainted session all
// leave it false, so its edits stay "foreign". Unlike `ai_sessions`
// (deleted at session end) and `ai_session_messages` (90-day retention)
// this row lives as long as the document's edit history does.
export const aiSessionProvenance = pgTable('ai_session_provenance', {
  sessionId: text('session_id').primaryKey(),
  docId: text('doc_id').notNull().references(() => documents.docId, { onDelete: 'cascade' }),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  clean: boolean('clean').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, table => [
  // Data export + account-deletion lookups by user.
  index('idx_ai_session_provenance_user').on(table.userId)
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
// `s3_key` is the FINAL key (`docs/{docId}/{fileId}`); the browser PUTs to
// a staging key (`docs/{docId}/staging/{fileId}`) that confirm copies from,
// so the presigned URL can never rewrite a confirmed image.
// Every row (pending or confirmed) counts against the uploader's
// `imageBytesPerUser` quota. The image GC (`server/utils/imageGc.ts`)
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
  // Synthetic-principal label for agent-driven rows. Carries the JWT's
  // userId verbatim when non-numeric — `'ai:assistant:{aiSessionId}'`
  // for the in-app loop, `'mcp:{mcpSessionId}'` for MCP. NULL for
  // human edits (which use `userId` instead).
  //
  // The unified-attribution chain that ActivityFeed renders against:
  //   actor_principal LIKE 'ai:assistant:%'
  //     → strip prefix → ai_sessions.session_id
  //       → ai_sessions.initiator_user_id → users (the human)
  //   actor_principal LIKE 'mcp:%'
  //     → strip prefix → mcp_sessions.mcp_session_id
  //       → mcp_sessions.user_id → users (the human)
  //       → mcp_sessions.client_name (e.g. 'Claude Desktop')
  //
  // Without this column, agent rows in `activity_log` have NO
  // traceback to the human initiator from the activity row alone.
  // The pre-Phase-3 implementation worked around this by hardcoding
  // `userName='AI Assistant'` for AI rows; this column moves the
  // identification to a structured field so MCP can join through
  // the same render layer without polluting `user_name`.
  actorPrincipal: text('actor_principal'),
  // Anonymous rows only: the random per-browser-tab avatar token the
  // editor's presence broadcast (awareness `user.avatarSeed`,
  // sessionStorage `markoto-anon-avatar`), so the Activity Log shows
  // the same generated face as the presence bar. Not derived from
  // anything about the visitor. NULL for signed-in users (avatar
  // seeded by `user_id`), agents and rows written before 0027.
  actorAvatarSeed: text('actor_avatar_seed'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, table => [
  index('idx_activity_doc').on(table.docId, table.createdAt),
  // Forensic queries for "every agent row across all docs": uncommon
  // (the per-doc activity feed is the hot path) but cheap to support.
  // Partial — only agent rows have a non-null principal, so the index
  // stays small.
  index('idx_activity_actor_principal').on(table.actorPrincipal).where(sql`actor_principal IS NOT NULL`),
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
  // The reported location exactly as the reporter gave it (DSA
  // Art.16(2)(b) "exact electronic location") — usually the document
  // URL. `doc_id` is what we could parse out of it. NULL on legacy rows.
  contentUrl: text('content_url'),
  // Logged-in reporter — populated when the form-submission path
  // is used. NULL for email-channel reports + for legacy rows.
  // Set null on user delete (we anonymise, don't cascade-delete
  // — the report itself is still actionable evidence even after
  // the reporter deletes their account).
  reporterUserId: integer('reporter_user_id').references(() => users.id, { onDelete: 'set null' }),
  // Optional reporter contact. Anonymous reports allowed.
  reporterEmail: text('reporter_email'),
  // Reporter's name as typed in the form (Art.16(2)(c); optional for
  // CSAM reports). Signed-in reporters default to their profile name.
  reporterName: text('reporter_name'),
  // UI locale at submission — the language of the receipt + decision
  // notice emails.
  reporterLocale: text('reporter_locale'),
  // When the reporter confirmed the good-faith statement (Art.16(2)(d)).
  // NULL only on legacy rows (before the statement existed).
  goodFaithConfirmedAt: timestamp('good_faith_confirmed_at', { withTimezone: true }),
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
  // The moderator's decision (set on actioned / dismissed): what was done
  // to the content, which rule it broke (shared/config/moderation.ts) and
  // the explanation shown to the reporter (Art.16(5)) and, for removed /
  // restricted content, to the document owner as the statement of reasons
  // (Art.17). Unlike `notes` these ARE sent to people.
  decisionAction: text('decision_action', {
    enum: ['content_removed', 'access_restricted', 'no_action']
  }),
  decisionRule: text('decision_rule'),
  decisionExplanation: text('decision_explanation'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
  actionedAt: timestamp('actioned_at', { withTimezone: true })
}, table => [
  // Triage queue: open reports oldest-first.
  index('idx_abuse_reports_status').on(table.status, table.createdAt),
  // Per-doc lookup for "any open reports against this doc?".
  index('idx_abuse_reports_doc').on(table.docId)
])

// Every notice the moderation pipeline produced for a report, with the
// exact text — the record of what we told whom (DSA Art.16(4)
// confirmation of receipt, Art.16(5) decision notice to the reporter,
// Art.17 statement of reasons to the owner of removed/restricted
// content). A notice that could not be delivered is recorded too
// (`not_delivered_*`), e.g. a statement of reasons for an anonymous
// document whose creator we have no way to contact. No email address is
// copied here: the reporter's lives on the report, the owner's on the
// account (`recipient_user_id`, nulled when the account is deleted).
export const moderationNotices = pgTable('moderation_notices', {
  id: serial('id').primaryKey(),
  noticeId: text('notice_id').notNull().unique(),
  reportId: text('report_id').notNull().references(() => abuseReports.reportId, { onDelete: 'cascade' }),
  kind: text('kind', { enum: ['receipt', 'decision', 'statement_of_reasons'] }).notNull(),
  recipientRole: text('recipient_role', { enum: ['reporter', 'owner'] }).notNull(),
  recipientUserId: integer('recipient_user_id').references(() => users.id, { onDelete: 'set null' }),
  status: text('status', {
    enum: ['sent', 'not_delivered_no_contact', 'failed']
  }).notNull(),
  locale: text('locale').notNull(),
  subject: text('subject').notNull(),
  body: text('body').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, table => [
  index('idx_moderation_notices_report').on(table.reportId, table.createdAt)
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

// MCP Personal Access Tokens. Long-lived bearer tokens that external MCP
// clients (Claude Desktop, Cursor, ChatGPT app store, ad-hoc scripts)
// present in `Authorization: Bearer <token>` to call our /mcp endpoint.
//
// Auth model: SHA-256-hashed at rest (the plaintext is shown ONCE on
// creation and never reconstructed — same pattern as GitHub PATs). The
// `Authorization` header is hashed on each MCP request and looked up
// against `tokenHash`; positive results are Valkey-cached for 60s to
// avoid a DB hit per tool call.
//
// Cascade-delete on user removal — a token without an owner has no
// principal to act as, so it's deleted alongside the user. Revocation
// (`revokedAt`) is a soft-delete: the row stays for audit but the
// verifier rejects it. Expiry (`expiresAt`) is optional; null = does
// not expire (rotation is the user's responsibility, surfaced in the
// /settings/integrations UI as a "last used" timestamp).
//
// Scopes are a typed subset of `documents:read | documents:write |
// knowledge:read | web:fetch`. Stored as a text array; per-tool
// `enabled` guards in server/mcp/tools/*.ts check membership before
// the tool is exposed.
export const mcpPersonalTokens = pgTable('mcp_personal_tokens', {
  id: serial('id').primaryKey(),
  // Public-facing handle (`mkt_pat_<nanoid>`); used in the API responses
  // and the URL of DELETE /api/mcp/tokens/:tokenId. Distinct from `id`
  // so leaks of the URL don't disclose row counts / creation order.
  tokenId: text('token_id').notNull().unique(),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  // User-supplied label ("Claude Desktop on laptop", "CI script"). Free-
  // form, ≤80 chars (validated at the API layer). Helps the user pick
  // the right token to revoke.
  name: text('name').notNull(),
  // SHA-256 of the plaintext token. The plaintext is `mkt_<32-char-base32>`
  // and exists only in memory long enough to return to the issuer; we
  // never store or log it. Hash is hex-encoded (64 chars).
  tokenHash: text('token_hash').notNull().unique(),
  // Granted scope list. v1 supports the four named scopes; tools gate
  // visibility via `enabled: event => hasScope(event, '...')`. Stored
  // as a text array (Postgres native) — we don't need joins here, just
  // membership checks at request time.
  scopes: text('scopes').array().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  // Bumped by the verifier on every successful authentication, capped to
  // once-per-minute via Valkey to avoid hot-row contention. Surfaced in
  // the UI so users can spot dormant tokens to revoke.
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  // Soft-delete. Set when the user clicks "Revoke" or when a sweeper
  // (future) ages out tokens past `expiresAt`. The verifier rejects any
  // row where this is non-null.
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  // Optional hard expiry. v1 leaves this null (manual revocation only);
  // a follow-up phase will default to 1y to force rotation.
  expiresAt: timestamp('expires_at', { withTimezone: true })
}, table => [
  // Verifier hot path: lookup by hash. Unique above already creates the
  // index — no extra index needed.
  // List endpoint: most-recent-first per user.
  index('idx_mcp_personal_tokens_user').on(table.userId, table.createdAt.desc())
])

// MCP Sessions. One row per Claude Desktop / Cursor / ChatGPT
// connection — assigned by the toolkit at `initialize` time, stable
// across every tool call in the same connection. Exists to close the
// audit-attribution gap: `activity_log` rows from MCP-driven edits
// are stamped `userId='mcp:{mcpSessionId}'` (synthetic principal,
// non-numeric — matches the existing AI loop pattern). Without this
// table, that string is a dead pointer — the forensic question "what
// did Claude Desktop do at 14:32" can only answer "MCP did it", not
// "user 42 via the 'home laptop' token". The join chain:
//
//   activity_log.user_id = 'mcp:{mcpSessionId}'
//     → mcp_sessions.mcp_session_id  (strip 'mcp:' prefix)
//       → mcp_sessions.user_id       → users.id (the human)
//       → mcp_sessions.token_id      → mcp_personal_tokens (which credential)
//
// Writer: `touchMcpSession` in `server/utils/mcpAuth.ts`, called from
// the MCP middleware. INSERT … ON CONFLICT DO UPDATE bumps
// `last_active_at`; Valkey throttles to once-per-minute so a chatty
// MCP client doesn't write 50 UPDATEs/sec to the same row.
//
// Cascade rules:
//   - user_id → users(id) ON DELETE CASCADE — a deleted user's
//     sessions go with them (no orphan rows pointing at nothing).
//   - token_id → mcp_personal_tokens(token_id) ON DELETE SET NULL —
//     if the PAT is hard-deleted (e.g. user-deletion cascade), the
//     session row survives with `token_id=NULL` so the audit trail
//     stays joinable to user_id. Soft-revocation (revoked_at) doesn't
//     null this column; it stays linked.
export const mcpSessions = pgTable('mcp_sessions', {
  id: serial('id').primaryKey(),
  // Toolkit-assigned UUID from `Mcp-Session-Id` response header.
  // Unique across all clients and times. Stripped of the `mcp:`
  // prefix used in activity_log (the prefix is applied at the join
  // boundary, not stored here).
  mcpSessionId: text('mcp_session_id').notNull().unique(),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  // Which PAT minted this session. `tokenId` (not the `id`) so the
  // FK works across PAT rotation + reveals nothing about row counts.
  tokenId: text('token_id').references(() => mcpPersonalTokens.tokenId, { onDelete: 'set null' }),
  // Free-form client identification from MCP `clientInfo.name` in the
  // initialize call ("Claude Desktop", "Cursor", "ChatGPT app", or
  // user-defined for ad-hoc scripts). May be null if we miss the
  // initialize call (we only see session-id starting on the second
  // call). Surfaced to users in `/settings/integrations` audit views.
  clientName: text('client_name'),
  // User-Agent header on the FIRST request that carried the session
  // id (typically the `initialized` notification). Captured once;
  // not updated on subsequent calls.
  userAgent: text('user_agent'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  // Bumped on every authenticated tool call. Valkey-throttled to
  // once-per-minute. Used for session-lifetime analysis + idle
  // pruning (future sweeper). Surfaced in /settings/integrations.
  lastActiveAt: timestamp('last_active_at', { withTimezone: true }).notNull().defaultNow()
}, table => [
  // Audit-forensics index: "every MCP session for this user, most
  // recent first". Also covers the FK lookup from user-deletion
  // cascade.
  index('idx_mcp_sessions_user').on(table.userId, table.lastActiveAt.desc()),
  // Token-attribution index: "every session that used this PAT".
  // Useful when triaging a leaked-token incident.
  index('idx_mcp_sessions_token').on(table.tokenId)
])

// Paid-plans waitlist (WP3). Only active while billing is OFF and the
// deployment advertises upcoming plans (`NUXT_PLANS_COMING_SOON`). Lawful
// basis: consent (GDPR Art.6(1)(a) / FADP Art.6(6)) — see
// `server/legal/lawfulBasis.ts#paid_plans_waitlist`.
//
// Double opt-in: a row is written UNCONFIRMED on signup and only counts
// once `confirmed_at` is set via the emailed confirm link. Unconfirmed
// rows are reaped by `server/utils/waitlistSweep.ts` after the confirm
// window. Unsubscribe DELETES the row (no suppression list — we hold
// nothing once consent is withdrawn).
//
// Privacy shape:
//   - `email` is normalised (trimmed + lower-cased) so re-signups are
//     idempotent; unique.
//   - Tokens are stored as SHA-256 hashes only; the raw values exist
//     only in the email we send. A DB leak can't be replayed into
//     confirm/unsubscribe actions.
//   - No IP address is stored at all (rate limiting happens in Valkey).
//   - `consent_version` + `consent_text_id` record WHICH consent text
//     the person agreed to (`shared/legal/versions.ts` +
//     the `waitlist.consentLabel` i18n key in the signup locale).
//   - `user_id` is set when a logged-in user signs up; CASCADE so
//     account deletion removes the waitlist entry with the account.
export const waitlistSignups = pgTable('waitlist_signups', {
  id: serial('id').primaryKey(),
  email: text('email').notNull().unique(),
  locale: text('locale').notNull(),
  consentVersion: integer('consent_version').notNull(),
  consentTextId: text('consent_text_id').notNull(),
  userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }),
  // Null once confirmed (the confirm link is single-use).
  confirmTokenHash: text('confirm_token_hash').unique(),
  confirmTokenExpiresAt: timestamp('confirm_token_expires_at', { withTimezone: true }),
  unsubscribeTokenHash: text('unsubscribe_token_hash').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true })
}, table => [
  // Account-deletion cascade + data-export lookup.
  index('idx_waitlist_signups_user').on(table.userId),
  // Sweeper: "unconfirmed rows past their confirm window".
  index('idx_waitlist_signups_unconfirmed').on(table.confirmTokenExpiresAt).where(sql`${table.confirmedAt} IS NULL`)
])

// Bring-your-own-key AI provider configs (WP4). One row per user per
// capability (`chat` | `image` | `transcription`). Every LLM call for
// that capability is routed through LiteLLM's zero-cost `byok/*`
// deployment with these values as clientside credentials, so the
// user's own provider account pays and the platform AI budget is not
// touched. See `server/utils/aiProviders/` + docs/AI-MODELS.md.
//
//   - `api_key_encrypted` uses the same AES-256-GCM scheme as the
//     LiteLLM virtual-key tokens (`server/utils/litellm/tokenCrypto.ts`,
//     keyed off LITELLM_SALT_KEY). The plaintext is never returned to
//     the client, never logged and never included in the data export;
//     `api_key_last4` is what the UI shows.
//   - `base_url` is validated against the BYOK URL policy at save time
//     AND re-validated on every request (DNS can change).
//   - `supports_tools` / `last_verified_at` record the last verification
//     probe (chat: a tool-call round trip at temperature 0).
//   - CASCADE on the user FK: account deletion removes the rows.
export const userAiProviders = pgTable('user_ai_providers', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  capability: text('capability', { enum: ['chat', 'image', 'transcription'] }).notNull(),
  baseUrl: text('base_url').notNull(),
  model: text('model').notNull(),
  apiKeyEncrypted: text('api_key_encrypted').notNull(),
  apiKeyLast4: text('api_key_last4').notNull(),
  supportsVision: boolean('supports_vision').notNull().default(false),
  supportsTools: boolean('supports_tools'),
  lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, table => [
  uniqueIndex('uq_user_ai_providers_user_capability').on(table.userId, table.capability)
])
