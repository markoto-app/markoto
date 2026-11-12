import { pgTable, serial, integer, bigint, text, timestamp, primaryKey, index, uniqueIndex, jsonb, vector, boolean, customType, check, doublePrecision, date } from 'drizzle-orm/pg-core'
import { sql, type SQL } from 'drizzle-orm'
import type { DocTheme } from '~~/shared/types/theme'
import type { ActivityMetadata } from '~~/shared/contracts/activity'
import type { AiMessageBody, AuditAfter, AuditBefore, AuditMetadata } from './columnTypes'
import type { OrderSensitiveStripeEvent, StripeSubscriptionStatus } from '~~/shared/contracts/stripe'

// drizzle has no native `tsvector`; generated columns are STORED so the
// GIN index stays in sync without triggers.
const tsvector = customType<{ data: string }>({
  dataType() { return 'tsvector' }
})

// Raw bytes (Y.js updates). Read and written with plain SQL through
// `server/utils/documents/yjsLog.ts`, never through drizzle's query builder.
const bytea = customType<{ data: Buffer }>({
  dataType() { return 'bytea' }
})

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  githubId: text('github_id').unique(),
  googleId: text('google_id').unique(),
  // Generic OpenID Connect identity. Keyed by the PAIR (issuer, subject):
  // `sub` is only unique per issuer, and the email is never the key.
  // Both set or both null (CHECK below).
  oidcIssuer: text('oidc_issuer'),
  oidcSubject: text('oidc_subject'),
  login: text('login'),
  name: text('name').notNull(),
  email: text('email'),
  // PERSONAL subscription tier: `free` or `pro`. Team / Business are
  // workspace subscriptions (`workspace_subscriptions`). Set by the
  // Stripe webhook when `invoice.paid` / `subscription.updated` lands.
  // See server/utils/AGENTS.md.
  plan: text('plan', { enum: ['free', 'pro'] }).notNull().default('free'),
  // Paid-tier expiry = Stripe's `current_period_end`. NULL for free
  // users (free never lapses). Set by the Stripe webhook; the
  // plan-lapse sweep flips the row back to `free` once past it.
  planValidUntil: timestamp('plan_valid_until', { withTimezone: true }),
  // Stripe's `current_period_start` for paid users — anchors the
  // AI-credits billing period so quota resets on the invoice day, not
  // on the 1st of the calendar month. NULL for free users (they fall
  // back to the calendar-month anchor). Updated on every `invoice.paid`.
  stripeCurrentPeriodStart: timestamp('stripe_current_period_start', { withTimezone: true }),
  stripeCustomerId: text('stripe_customer_id').unique(),
  stripeSubscriptionId: text('stripe_subscription_id').unique(),
  // Currency of the personal subscription. A Stripe customer keeps one
  // currency for life, so checkout refuses a different one (409
  // `billing/currency-locked`). NULL until the first subscription.
  billingCurrency: text('billing_currency', { enum: ['eur', 'chf'] }),
  // Platform chat model the user picked: 'fast' = the instance chat
  // default, 'strong' = NUXT_AI_DEFAULT_CHAT_STRONG_MODEL — only applied
  // while the plan includes `aiStrongModel`. Own keys are unaffected.
  aiModelTier: text('ai_model_tier', { enum: ['fast', 'strong'] }).notNull().default('fast'),
  // LiteLLM virtual-key handle: the single source of truth for the
  // user's AI budget. Every billable AI call goes through
  // `useLitellmForUser(litellmKeyToken)` and LiteLLM enforces the plan's
  // `max_budget`. Lazy-created on first AI use via
  // `ensureUserKey(userId, plan)`; updated by Stripe webhooks on plan
  // changes.
  //
  // The token is encrypted at rest with `NUXT_ENCRYPTION_KEY` (server/utils/platform/secretBox.ts) and only held
  // in memory to build the OpenAI SDK client. `litellmKeyId` is LiteLLM's
  // internal token id, accepted by `/key/info` in place of the token.
  litellmKeyId: text('litellm_key_id').unique(),
  litellmKeyToken: text('litellm_key_token'),
  // Platform-admin flag. Source of truth for `/admin/*` access.
  // A user whose email is in `NUXT_ADMIN_USER_EMAILS` is promoted on
  // their next OAuth login (`upsertOAuthUser`); after that the column is
  // the durable record. Never set it without the user's consent and an
  // `admin.granted` audit row.
  isAdmin: boolean('is_admin').notNull().default(false),
  // Preferred locale for transactional emails and the legal-document
  // fallback. NULL means "never chose, use Accept-Language at send time";
  // don't default to 'en', that erases the difference between "picked
  // English" and "never asked".
  locale: text('locale'),
  // GDPR Art. 8 age confirmation. NULL means "not yet confirmed" and the
  // onboarding gate forces the user through it. Never backfill a value
  // for accounts that were not asked: a default would be a false record.
  ageConfirmedAt: timestamp('age_confirmed_at', { withTimezone: true }),
  // GDPR Art. 17 deletion request: a 30-day grace period during which
  // the user can cancel; `accountDeletionSweep` hard-deletes rows past
  // `deletionGraceUntil`. NULL on both = account is active.
  deletionRequestedAt: timestamp('deletion_requested_at', { withTimezone: true }),
  deletionGraceUntil: timestamp('deletion_grace_until', { withTimezone: true }),
  // Acceptance state for the legal documents. The integer is the version
  // accepted (compared with `shared/legal/versions.ts`; a bump re-prompts).
  // `_locale` records which translation the user saw, in case it drifts
  // from the authoritative English text. Nullable because the DPA only
  // applies to workspace owners.
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
  // cookie at once (cookies themselves can't be recalled). A cookie
  // without `e` counts as epoch 0.
  sessionEpoch: integer('session_epoch').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, table => [
  // Partial indexes: the plan-lapse and account-deletion sweeps scan these
  // columns, which are null for most rows.
  index('idx_users_plan_valid_until').on(table.planValidUntil).where(sql`${table.planValidUntil} is not null`),
  index('idx_users_deletion_grace_until').on(table.deletionGraceUntil).where(sql`${table.deletionGraceUntil} is not null`),
  uniqueIndex('uq_users_oidc_identity').on(table.oidcIssuer, table.oidcSubject),
  check('ck_users_oidc_identity_pair', sql`(${table.oidcIssuer} is null) = (${table.oidcSubject} is null)`)
])

export const documents = pgTable('documents', {
  id: serial('id').primaryKey(),
  docId: text('doc_id').notNull().unique(),
  ownerId: integer('owner_id').references(() => users.id),
  // Optional parent workspace, set at creation and movable via
  // PATCH /api/docs/:docId/workspace (canManageDoc on source + admin/editor
  // on target). Workspace delete cascades per doc in the app via
  // `deleteDocument()`; the `set null` FK is only a fallback.
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
  // Share-link controls. After `share_expires_at` a public access
  // mode (open-edit / open-view / password) acts as `private` for
  // everyone but the owner and workspace members (`docStateOf`).
  // `share_no_download`: those visitors get no PDF / Markdown download and
  // no print. NULL / false = off.
  shareExpiresAt: timestamp('share_expires_at', { withTimezone: true }),
  shareNoDownload: boolean('share_no_download').notNull().default(false),
  // Set when a moderator restricts the document on an abuse report: it
  // stays private and unpublished — no access mode but `private`, no
  // password, no guest share, no web page, no move into a workspace —
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
  lastActive: timestamp('last_active', { withTimezone: true }).notNull().defaultNow()
}, table => [
  index('idx_documents_owner').on(table.ownerId),
  index('idx_documents_last_active').on(table.lastActive),
  index('idx_documents_workspace').on(table.workspaceId)
])

// A document's Y.js state as an append-only log (written by the sync server,
// read by history replay, duplicate, render, export and the image GC).
//
// - `update`: a Y.js update — what one store added since the previous store of
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

export const workspaces = pgTable('workspaces', {
  id: serial('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().unique(),
  // Immutable original creator. Authorization goes through
  // `workspace_members.role`; ownerId is provenance only and is not
  // changed by promoting/demoting admins.
  ownerId: integer('owner_id').notNull().references(() => users.id),
  name: text('name').notNull().default('My Workspace'),
  description: text('description'),
  // Theme applied to NEW documents in this workspace. NULL = the built-in
  // preset. Snapshotted at creation: changing it doesn't retheme existing
  // docs.
  defaultTheme: jsonb('default_theme').$type<DocTheme>(),
  // Brand kit: while true (and the plan includes `brandKit`), every
  // document in the workspace renders with `default_theme`'s design —
  // only its cover text stays its own (shared/utils/theme/brandLock.ts).
  // Enforced at render time; the documents' own themes are untouched.
  brandLocked: boolean('brand_locked').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, table => [
  index('idx_workspaces_owner').on(table.ownerId)
])

// Team / Business subscription of a workspace. One row
// per workspace that ever had one; Stripe drives every column through the
// webhook. `resolveWorkspacePlan` (server/utils/billing/entitlements.ts)
// counts a row only while billing is on, `status` is live and
// `valid_until` is in the future; otherwise the workspace falls back to
// its creator's personal plan.
export const workspaceSubscriptions = pgTable('workspace_subscriptions', {
  workspaceId: text('workspace_id').primaryKey().references(() => workspaces.workspaceId, { onDelete: 'cascade' }),
  plan: text('plan', { enum: ['team', 'business'] }).notNull(),
  // Paid seats. Members + open invitations may not exceed it.
  seats: integer('seats').notNull(),
  // Stripe subscription status, verbatim (active, trialing, past_due,
  // canceled, unpaid, incomplete, incomplete_expired, paused).
  status: text('status').$type<StripeSubscriptionStatus>().notNull(),
  // The member who pays and manages billing. SET NULL when their account
  // is deleted; the account-deletion flow hands the role to the
  // longest-serving workspace admin first.
  billingAdminId: integer('billing_admin_id').references(() => users.id, { onDelete: 'set null' }),
  stripeCustomerId: text('stripe_customer_id'),
  stripeSubscriptionId: text('stripe_subscription_id').unique(),
  currentPeriodStart: timestamp('current_period_start', { withTimezone: true }),
  validUntil: timestamp('valid_until', { withTimezone: true }),
  // LiteLLM team holding the workspace's pooled AI budget.
  litellmTeamId: text('litellm_team_id'),
  // Seat changes inside the current LiteLLM budget window (30 days).
  // Added seats are charged pro rata, so they unlock budget only for the
  // days left in the window; removed seats were paid for the whole
  // window, so their budget stays until it ends. The pooled AI budget
  // counts `seats + budget_seat_adjust` seats until
  // `budget_seat_adjust_until` (the window end), then `seats` again
  // (`workspaceBilling.ts#budgetSeats`).
  budgetSeatAdjust: doublePrecision('budget_seat_adjust').notNull().default(0),
  budgetSeatAdjustUntil: timestamp('budget_seat_adjust_until', { withTimezone: true }),
  // Stripe customers keep one currency for life.
  currency: text('currency', { enum: ['eur', 'chf'] }).notNull().default('eur'),
  interval: text('interval', { enum: ['month', 'year'] }).notNull().default('month'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, table => [
  index('idx_workspace_subscriptions_billing_admin').on(table.billingAdminId),
  index('idx_workspace_subscriptions_customer').on(table.stripeCustomerId)
])

// AI credit top-ups: one row per paid top-up, for a
// user (Pro) or a workspace (Team / Business). `subject_id` is the user
// id or the workspace id as text (no FK: two subject kinds; account and
// workspace deletion delete the rows explicitly). `remaining_usd` goes
// down as the subject's AI spend passes its plan budget (monthly
// settlement, `server/utils/billing/aiCredits.ts`) and with refunds; a grant
// expires 12 months after purchase. `stripe_payment_intent_id` is unique
// so a repeated webhook adds nothing.
export const aiCreditGrants = pgTable('ai_credit_grants', {
  id: serial('id').primaryKey(),
  subjectType: text('subject_type', { enum: ['user', 'workspace'] }).notNull(),
  subjectId: text('subject_id').notNull(),
  pack: text('pack').notNull(),
  amountUsd: doublePrecision('amount_usd').notNull(),
  remainingUsd: doublePrecision('remaining_usd').notNull(),
  refundedUsd: doublePrecision('refunded_usd').notNull().default(0),
  // What was paid, in the currency's minor units (cents / Rappen).
  amountPaid: integer('amount_paid').notNull(),
  currency: text('currency', { enum: ['eur', 'chf'] }).notNull(),
  stripePaymentIntentId: text('stripe_payment_intent_id').notNull().unique(),
  stripeCheckoutSessionId: text('stripe_checkout_session_id'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, table => [
  index('idx_ai_credit_grants_subject').on(table.subjectType, table.subjectId)
])

// How much of a subject's credits one calendar month (UTC — LiteLLM's
// monthly budget reset) used: the month's AI spend above the plan
// budget, deducted from the grants once. Lets the settlement run
// repeatedly without deducting twice.
export const aiCreditSettlements = pgTable('ai_credit_settlements', {
  subjectType: text('subject_type', { enum: ['user', 'workspace'] }).notNull(),
  subjectId: text('subject_id').notNull(),
  // 'YYYY-MM'
  period: text('period').notNull(),
  consumedUsd: doublePrecision('consumed_usd').notNull().default(0),
  // The highest plan budget (USD, without credits) the subject had while
  // this month was open, recorded by every settlement run. A closed month
  // is settled against it, never against today's plan (a cancelled plan
  // would otherwise turn the whole month's spend into credit use).
  // NULL = no settlement ran while the month was open.
  planBudgetUsd: doublePrecision('plan_budget_usd'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
}, table => [
  primaryKey({ columns: [table.subjectType, table.subjectId, table.period] })
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
  // `guest`: someone outside the team who sees ONLY the documents
  // shared with them (`document_shares`). Not a member for any
  // workspace-level access — `getMemberRole` returns null for guests.
  role: text('role', { enum: ['admin', 'editor', 'viewer', 'guest'] }).notNull().default('editor'),
  joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
  // Team / Business: the member's monthly AI limit inside the
  // workspace's pooled budget, in USD. NULL = the default (2 × the
  // per-seat budget); `ai_unlimited` = no member limit (the team budget
  // still applies). Set by workspace admins.
  aiLimitUsd: doublePrecision('ai_limit_usd'),
  aiUnlimited: boolean('ai_unlimited').notNull().default(false),
  // The member's LiteLLM key inside the workspace's LiteLLM team, created
  // on first AI use there (`server/utils/litellm/workspaceTeams.ts`).
  // Token AES-256-GCM-encrypted like `users.litellm_key_token`.
  litellmKeyId: text('litellm_key_id'),
  litellmKeyToken: text('litellm_key_token')
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
  role: text('role', { enum: ['admin', 'editor', 'viewer', 'guest'] }).notNull().default('editor'),
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
// only — no visitor, address or cookie is recorded.
export const documentViewDays = pgTable('document_view_days', {
  docId: text('doc_id').notNull().references(() => documents.docId, { onDelete: 'cascade' }),
  day: date('day', { mode: 'string' }).notNull(),
  opens: integer('opens').notNull().default(0)
}, table => [
  primaryKey({ columns: [table.docId, table.day] })
])

// A published page is a static web snapshot of a document: the HTML the
// print page rendered (markdown → sanitised HTML, theme CSS, no cover, no
// pagination), served at `/p/<slug>` (and on a verified custom domain)
// with a no-script CSP. Re-publishing replaces the snapshot; the document
// itself is never exposed through it. Its images and brand fonts are
// copied to `published/<id>/` in S3 so the page doesn't depend on the
// document's uploads (image GC, deletion) or access mode.
export const publishedPages = pgTable('published_pages', {
  id: text('id').primaryKey(),
  docId: text('doc_id').notNull().unique().references(() => documents.docId, { onDelete: 'cascade' }),
  slug: text('slug').notNull().unique(),
  title: text('title').notNull(),
  language: text('language').notNull().default('en'),
  html: text('html').notNull(),
  css: text('css').notNull(),
  fontsImport: text('fonts_import').notNull().default(''),
  hljsUrl: text('hljs_url'),
  /** Off by default: `noindex` unless the publisher opts in. */
  indexable: boolean('indexable').notNull().default(false),
  publishedByUserId: integer('published_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  publishedAt: timestamp('published_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
})

// A custom domain (plan feature `customDomains`) shows one published page
// at its root. Owned by the user who added it; verified by a TXT record
// `_markoto-verify.<hostname>` = `markoto-verify=<token>` plus a CNAME to
// the instance's pages host. Only `verified` domains are routed (Traefik
// HTTP provider) and get a certificate.
export const customDomains = pgTable('custom_domains', {
  id: text('id').primaryKey(),
  // Unique only among VERIFIED domains: an unproven claim must not block
  // the real owner (squatting). One row per user and hostname.
  hostname: text('hostname').notNull(),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  pageId: text('page_id').references(() => publishedPages.id, { onDelete: 'set null' }),
  verifyToken: text('verify_token').notNull(),
  status: text('status', { enum: ['pending', 'verified', 'failed'] }).notNull().default('pending'),
  lastError: text('last_error'),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, table => [
  index('idx_custom_domains_user').on(table.userId),
  index('idx_custom_domains_page').on(table.pageId),
  uniqueIndex('uq_custom_domains_verified_host').on(table.hostname).where(sql`${table.status} = 'verified'`),
  uniqueIndex('uq_custom_domains_user_host').on(table.userId, table.hostname)
])

// Brand kit: fonts and logos uploaded by a workspace's admins. A font file is one
// family + weight + style; static TrueType outlines only (variable and
// CFF fonts print as Type 3 in Chromium's PDFs and are refused —
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

// Per-workspace single sign-on. A Business workspace connects its own identity provider (OIDC or SAML).
// See `server/utils/sso/AGENTS.md` for the flow; the rules in short:
//
//   - One connection per workspace. `draft` until an admin completed a
//     test sign-in through it, then `active`. An active connection is
//     ALWAYS enforced: members reach the workspace only with a current
//     `sso_grants` row (written by a sign-in through it, 12 h).
//   - Domains: the workspace proves ownership with a DNS TXT record. A
//     verified domain is unique across workspaces; only addresses in a
//     verified domain link to an existing account or join by JIT.
//   - Identities: (connection, subject) → user. Separate from the
//     instance-wide OIDC columns on `users`, which are for the operator's IdP.
export const ssoConnections = pgTable('sso_connections', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().unique().references(() => workspaces.workspaceId, { onDelete: 'cascade' }),
  protocol: text('protocol', { enum: ['oidc', 'saml'] }).notNull(),
  status: text('status', { enum: ['draft', 'active'] }).notNull().default('draft'),
  // OIDC: issuer (https), client id, client secret (AES-256-GCM, never
  // returned to the client).
  oidcIssuer: text('oidc_issuer'),
  oidcClientId: text('oidc_client_id'),
  oidcClientSecret: text('oidc_client_secret'),
  // SAML: the IdP's entity id, its SSO (redirect-binding) URL and its
  // signing certificate (PEM, pasted — never fetched).
  samlIdpEntityId: text('saml_idp_entity_id'),
  samlSsoUrl: text('saml_sso_url'),
  samlIdpCert: text('saml_idp_cert'),
  // Role of a member who joins by signing in (JIT) or by SCIM.
  defaultRole: text('default_role', { enum: ['editor', 'viewer'] }).notNull().default('editor'),
  // SCIM bearer token, SHA-256 (the raw token is shown once).
  scimTokenHash: text('scim_token_hash').unique(),
  createdByUserId: integer('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  activatedAt: timestamp('activated_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
})

export const ssoDomains = pgTable('sso_domains', {
  id: serial('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.workspaceId, { onDelete: 'cascade' }),
  // Lower-case, no trailing dot.
  domain: text('domain').notNull(),
  // Value of the `markoto-verification=<token>` TXT record.
  verificationToken: text('verification_token').notNull(),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, table => [
  uniqueIndex('uq_sso_domains_ws_domain').on(table.workspaceId, table.domain),
  // A domain can be VERIFIED by one workspace only.
  uniqueIndex('uq_sso_domains_verified').on(table.domain).where(sql`${table.verifiedAt} is not null`)
])

export const userIdentities = pgTable('user_identities', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  connectionId: text('connection_id').notNull().references(() => ssoConnections.id, { onDelete: 'cascade' }),
  // OIDC `sub` / SAML NameID (persistent) — never the email.
  subject: text('subject').notNull(),
  // SCIM `externalId` / `id` mapping: SCIM-created identities carry it.
  scimExternalId: text('scim_external_id'),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true })
}, table => [
  uniqueIndex('uq_user_identities_conn_subject').on(table.connectionId, table.subject),
  index('idx_user_identities_user').on(table.userId)
])

// A sign-in through a workspace's IdP: lets the user into that workspace
// while SSO is enforced. Valid until `expires_at` (12 h) and only for the
// session epoch it was written in ("log out everywhere" voids it).
export const ssoGrants = pgTable('sso_grants', {
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.workspaceId, { onDelete: 'cascade' }),
  sessionEpoch: integer('session_epoch').notNull(),
  grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull()
}, table => [
  primaryKey({ columns: [table.userId, table.workspaceId] })
])

// Active AI sessions. Persisted so the per-user-per-doc cap survives
// restarts. Abort controllers are in-memory only.
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

// Per-(doc, user) memory for the AI loop, so a follow-up prompt can
// resolve "it" / "that table" across separate /api/ai/prompt requests.
//
// Compaction (`server/utils/agentic/conversationMemory.ts`):
//   - user_prompt / message_to_user: body verbatim.
//   - tool_call: tool NAME + a short arg summary only. Results are never
//     stored; the model re-issues the call if it needs them.
//
// Cascades with the doc, and with the user: rows hold literal prompts, so
// they are deleted on account deletion rather than anonymised.
export const aiSessionMessages = pgTable('ai_session_messages', {
  id: serial('id').primaryKey(),
  docId: text('doc_id').notNull().references(() => documents.docId, { onDelete: 'cascade' }),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  // The AI session that produced this row. Not a FK: ai_sessions rows are
  // pruned at session end while memory persists.
  sessionId: text('session_id').notNull(),
  kind: text('kind', { enum: ['user_prompt', 'tool_call', 'message_to_user'] }).notNull(),
  // Shape varies by kind:
  //   user_prompt:      { text }
  //   tool_call:        { name, summary }
  //   message_to_user:  { message, isQuestion }
  body: jsonb('body').$type<AiMessageBody>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, table => [
  // Hot path: this user's recent memory for this doc.
  index('idx_ai_msg_doc_user_time').on(table.docId, table.userId, table.createdAt)
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

// Workspace knowledge base: files uploaded so the AI can retrieve grounded
// content in any doc of the workspace. Ingest: S3 → markitdown → chunker →
// LiteLLM embeddings → chunks table; exposed to the AI via
// `search_knowledge` and `get_knowledge_file`.
//
// Workspace delete cascades via FK; deleting a row also removes its chunks
// (FK cascade) and the original S3 object.
export const workspaceKnowledge = pgTable('workspace_knowledge', {
  id: serial('id').primaryKey(),
  knowledgeId: text('knowledge_id').notNull().unique(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.workspaceId, { onDelete: 'cascade' }),
  // Display name. Collisions get a numeric suffix at confirm time
  // (`report.pdf`, `report (2).pdf`).
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
  // Key like `jina/jina-embeddings-v5-text-nano:768`, so chunks produced
  // with an old model/dim can be detected and re-embedded.
  embeddingVersion: text('embedding_version').notNull(),
  uploaderId: integer('uploader_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp('processed_at', { withTimezone: true })
}, table => [
  index('idx_wk_workspace').on(table.workspaceId),
  // Sweep stuck-processing rows older than N minutes.
  index('idx_wk_status_created').on(table.status, table.createdAt),
  // The confirm endpoint suffixes on collision before insert.
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
  // 768 dims = Jina v5-text-nano native. pgvector caps HNSW at 2000
  // dims; larger models would need IVFFlat (slower, worse recall).
  embedding: vector('embedding', { dimensions: 768 }),
  // Full-text side of hybrid search; fused with vector similarity via
  // Reciprocal Rank Fusion in `searchKnowledge`.
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

// `metadata` carries structured detail per action — comment id + body
// preview for `comment.*`, before/after for `title.changed`, tool name +
// args preview for `ai.tool`. The UI renders human-readable strings via
// i18n at read time, so the row stays locale-agnostic. Action enum is a
// text column (not pgEnum) so adding values is TS-only — no ALTER TYPE.
export const activityLog = pgTable('activity_log', {
  id: serial('id').primaryKey(),
  docId: text('doc_id').notNull().references(() => documents.docId),
  // The user who triggered this activity (avatar lookup joins on it).
  // NULL for AI rows and anonymous edits; `set null` on user deletion
  // keeps the row.
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
  metadata: jsonb('metadata').$type<ActivityMetadata>(),
  // `yjs_updates` ids around the store event that produced this row: the
  // document's newest row id BEFORE the store and the id the store wrote.
  // The diff endpoint and restore replay the doc at them. Nullable: some
  // actions (e.g. metadata-only events fired ahead of the store flush)
  // have neither. No FK: rows below the history floor may be pruned
  // (`docs/restore-compacted` / `docs/diff-unavailable`).
  yjsDocIdBefore: bigint('yjs_doc_id_before', { mode: 'number' }),
  yjsDocIdAfter: bigint('yjs_doc_id_after', { mode: 'number' }),
  // Principal label for agent-driven rows: the JWT's userId verbatim when
  // non-numeric (`'ai:assistant:{aiSessionId}'` for the in-app loop,
  // `'mcp:{mcpSessionId}'` for MCP). NULL for human edits (`userId`).
  //
  // Attribution chain ActivityFeed renders:
  //   actor_principal LIKE 'ai:assistant:%'
  //     → strip prefix → ai_sessions.session_id
  //       → ai_sessions.initiator_user_id → users (the human)
  //   actor_principal LIKE 'mcp:%'
  //     → strip prefix → mcp_sessions.mcp_session_id
  //       → mcp_sessions.user_id → users (the human)
  //       → mcp_sessions.client_name (e.g. 'Claude Desktop')
  actorPrincipal: text('actor_principal'),
  // Anonymous rows only: the random per-browser-tab avatar token from the
  // presence broadcast (awareness `user.avatarSeed`, sessionStorage
  // `markoto-anon-avatar`), so the Activity Log shows the same face as
  // the presence bar. Not derived from anything about the visitor. NULL
  // for signed-in users (seeded by `user_id`) and agents.
  actorAvatarSeed: text('actor_avatar_seed'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, table => [
  index('idx_activity_doc').on(table.docId, table.createdAt),
  // Forensic "every agent row across all docs"; partial because only
  // agent rows have a principal.
  index('idx_activity_actor_principal').on(table.actorPrincipal).where(sql`actor_principal IS NOT NULL`),
  // Closes the cross-instance flush race: two sync containers flushing the same doc
  // post identical `edit` rows with the same boundary ids; this makes the
  // second INSERT a no-op (`ON CONFLICT DO NOTHING` in `appendActivity`).
  //
  // Limited to the three sync-server actions, whose `(docId,
  // yjsDocIdAfter)` is unique per flush. Comment rows legitimately share
  // a `yjsDocIdAfter` within one snapshot batch, and restore rows are
  // user-originated, so both insert unconditionally.
  uniqueIndex('uq_activity_doc_yjsafter')
    .on(table.docId, table.yjsDocIdAfter)
    .where(sql`yjs_doc_id_after IS NOT NULL AND action IN ('edit', 'title.changed', 'theme.changed')`)
])

// Append-only audit log of security-sensitive operations (access
// changes, deletions, membership, billing). Separate from `activity_log`
// (the user-facing per-doc feed): never auto-pruned, and only for admin /
// forensic use.
//
// Append-only by convention: the repo exports no update or delete.
//
// `actor_ip` is truncated to /24 (IPv4) or /48 (IPv6) before storage;
// full IPs are never persisted.
//
// A failed write must NOT propagate to the caller: the primary action
// has already committed, and failing it over a wedged audit log is worse
// than a missing row. The repo swallows the error and reports to Sentry.
export const auditLog = pgTable('audit_log', {
  id: serial('id').primaryKey(),
  ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
  // Null for system actions. `set null` so account deletion keeps the row.
  actorUserId: integer('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
  // Captured at action time, truncated to /24 (IPv4) / /48 (IPv6).
  // Null for server-internal actions.
  actorIp: text('actor_ip'),
  // What was acted on; (scope, scope_id) is the main filter.
  scope: text('scope', { enum: ['doc', 'workspace', 'user', 'billing', 'system'] }).notNull(),
  // Id of the scoped entity (doc id, workspace id, or user id as text).
  scopeId: text('scope_id'),
  // Lowercase, dot-separated, namespace-first: 'doc.deleted',
  // 'workspace.member_role_changed', 'billing.plan_changed'. Registry:
  // `server/legal/auditActions.ts`.
  action: text('action').notNull(),
  // State before the action, shaped per action, e.g. { accessMode: 'open-edit' }.
  // Never holds secrets: passwords are recorded as { hasPassword: bool }.
  before: jsonb('before').$type<AuditBefore>(),
  // State after.
  after: jsonb('after').$type<AuditAfter>(),
  // Free-form context. Examples: { reason: 'workspace_cascade' },
  // { affectedUserId: 42 }, { stripeEventId: 'evt_xxx' }.
  metadata: jsonb('metadata').$type<AuditMetadata>(),
  // The workspace the event belongs to (for the workspace audit-log
  // viewer). Set for every `workspace` / `billing` event (= scope_id) and
  // for document events of a workspace document (the workspace at the
  // time). Plain text, no FK: the record outlives the workspace.
  workspaceId: text('workspace_id')
}, t => [
  index('idx_audit_scope').on(t.scope, t.scopeId, t.ts.desc()),
  // Everything one actor did (compromised-account investigations).
  index('idx_audit_actor').on(t.actorUserId, t.ts.desc()),
  // Workspace audit-log viewer + export.
  index('idx_audit_workspace').on(t.workspaceId, t.ts.desc())
])

// Stripe webhook event-id dedup. Stripe redelivers at least once, with
// the same `event.id`. Plain UPSERT idempotency is not enough: a stale
// redelivery after a manual correction (e.g. plan reset to 'free' for a
// refund) or after cancel-then-resubscribe would clobber newer state.
//
// The INSERT happens in the same transaction as the user-row update; on
// conflict the handler answers 200 + `replayed:true`. Stripe replays
// within ~3 days; rows are kept 90 days for forensics, then pruned by a
// daily sweeper.
export const processedWebhookEvents = pgTable('processed_webhook_events', {
  eventId: text('event_id').primaryKey(),
  type: text('type').notNull(),
  processedAt: timestamp('processed_at', { withTimezone: true }).notNull().defaultNow()
}, t => [
  index('idx_pwe_processed_at').on(t.processedAt)
])

// Out-of-order webhook stash. Stripe doesn't order deliveries:
// subscription.* events can arrive BEFORE checkout.session.completed,
// while `users.stripe_customer_id` is still null, so a handler keyed on
// it matches nothing. `handleCheckoutSessionCompleted` also fetches the
// live subscription, which masks the drop; don't remove that fetch
// without this stash. Unmatched events are stored by `customerId`, then
// drained in `received_at` order and marked `processed=true` once
// `checkout.session.completed` binds the customer to the user.
//
// A daily sweeper prunes processed rows after 7 days and never-replayed
// rows after 30 (the checkout never landed).
export const pendingStripeEvents = pgTable('pending_stripe_events', {
  // Stripe's event.id: PK, so redelivering a stashed event is a no-op.
  eventId: text('event_id').primaryKey(),
  customerId: text('customer_id').notNull(),
  type: text('type').notNull(),
  // Replayed verbatim through the dispatcher once the customer is bound.
  payload: jsonb('payload').$type<OrderSensitiveStripeEvent>().notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  // True once replayed against a bound user row; kept a week for audit.
  processed: boolean('processed').notNull().default(false),
  processedAt: timestamp('processed_at', { withTimezone: true })
}, t => [
  // Drain: customer_id = $1 AND processed = false ORDER BY received_at.
  index('idx_pse_customer_unprocessed').on(t.customerId, t.processed, t.receivedAt),
  index('idx_pse_received_at').on(t.receivedAt)
])

// Postgres mirror of the doc's comment threads, for cross-doc questions
// ("comments mentioning user X") without loading every Y.Doc. Y.js is the
// source of truth; the editor sidebar reads it directly.
//
// The sync server's `onStoreDocument` hook posts a full snapshot of the
// comments Y.Array to `/api/internal/comments-snapshot`, which replaces
// the doc's rows, so the table lags by a few seconds.
//
// Replies share the table: `parentCommentId` is set for replies and null
// for thread roots.
export const documentComments = pgTable('document_comments', {
  docId: text('doc_id').notNull().references(() => documents.docId, { onDelete: 'cascade' }),
  // Y.js entry id (nanoid(12)); a reply has its own id.
  entryId: text('entry_id').notNull(),
  // NULL = thread root; otherwise the `entry_id` of the parent in the same doc.
  parentCommentId: text('parent_comment_id'),
  // Author name snapshot, as shown on the comment.
  authorId: integer('author_id').references(() => users.id, { onDelete: 'set null' }),
  authorName: text('author_name').notNull(),
  body: text('body').notNull(),
  // Y.js epoch-ms timestamps, mirrored verbatim so ordering matches the editor.
  createdAtMs: timestamp('created_at_ms', { withTimezone: true, mode: 'date' }).notNull(),
  updatedAtMs: timestamp('updated_at_ms', { withTimezone: true, mode: 'date' }).notNull(),
  resolved: boolean('resolved').notNull().default(false),
  // Always false today: resolving the anchor needs the live Y.Doc, which
  // the snapshot path doesn't have.
  orphaned: boolean('orphaned').notNull().default(false)
}, table => [
  primaryKey({ columns: [table.docId, table.entryId] }),
  index('idx_document_comments_author').on(table.authorId),
  index('idx_document_comments_updated').on(table.updatedAtMs)
])

// Append-only consent ledger (GDPR Art. 7(1) proof of consent): one row
// per decision, per purpose, per point in time.
//
// Anonymous visitors are covered: `userId` is nullable and `anonId` is the
// first-party cookie that anchors pre-login decisions; a later login adds
// a row linking them and keeps the anonymous rows.
//
// Full IPs are never stored: `ipTruncated` follows the
// `audit_log.actor_ip` convention (/24 IPv4, /48 IPv6) and the
// user-agent is kept only as a SHA-256 hash.
//
// The repo exposes no UPDATE or DELETE. Withdrawing consent is a NEW row
// with `granted=false`; the latest row per (subject, purpose) wins.
export const consentLog = pgTable('consent_log', {
  id: serial('id').primaryKey(),
  // NULL for anonymous consent. `set null` so account deletion keeps the
  // proof, anonymised.
  userId: integer('user_id').references(() => users.id, { onDelete: 'set null' }),
  // First-party cookie id. Always set, even for signed-in users, so a
  // re-prompt after a consent-version bump works before the session
  // resolves.
  anonId: text('anon_id').notNull(),
  // The processing purpose this row decides. Only `essential` is
  // recordable now (`server/utils/privacy/consentDecisions.ts`); the other
  // two values stay for rows written under consent version 1.
  purpose: text('purpose', {
    enum: ['essential', 'analytics', 'session_replay']
  }).notNull(),
  granted: boolean('granted').notNull(),
  // Consent version the user saw. Bumping `consentVersion` in
  // `shared/legal/versions.ts` invalidates prior consent.
  version: integer('version').notNull(),
  // Locale the text was shown in, in case a translation drifts from the
  // authoritative English.
  locale: text('locale').notNull(),
  // /24 (IPv4) or /48 (IPv6), as in audit_log.actorIp.
  ipTruncated: text('ip_truncated'),
  // SHA-256 of the User-Agent: the raw fingerprint isn't kept, but two
  // consents from one browser still match.
  userAgentHash: text('user_agent_hash'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
}, table => [
  // Latest consent state per purpose, by user or by anon id.
  index('idx_consent_log_user').on(table.userId, table.purpose, table.createdAt.desc()),
  index('idx_consent_log_anon').on(table.anonId, table.purpose, table.createdAt.desc())
])

// DSA Art. 16 notice-and-action: anyone, signed in or not, can report a
// public document via `/legal/abuse` or the in-product menu.
//
// The reporter email is optional (the DSA doesn't require identity), but
// acknowledgements only go out when one is given. The reporter's IP is
// truncated like in audit_log + consent_log.
//
// `docId` is nullable so platform-wide reports have a home.
export const abuseReports = pgTable('abuse_reports', {
  id: serial('id').primaryKey(),
  reportId: text('report_id').notNull().unique(),
  // Free text: reporters paste URLs, bare doc ids, typos, "platform-wide".
  // Deliberately NOT an FK to documents.doc_id: the report stays evidence
  // even if the doc never existed or was deleted because of the report.
  docId: text('doc_id'),
  // The reported location exactly as the reporter gave it (DSA
  // Art.16(2)(b) "exact electronic location") — usually the document
  // URL. `doc_id` is what we could parse out of it.
  contentUrl: text('content_url'),
  // Signed-in reporter; NULL for email-channel reports. `set null` on user
  // delete: the report stays actionable evidence.
  reporterUserId: integer('reporter_user_id').references(() => users.id, { onDelete: 'set null' }),
  reporterEmail: text('reporter_email'),
  // Reporter's name as typed in the form (Art.16(2)(c); optional for
  // CSAM reports). Signed-in reporters default to their profile name.
  reporterName: text('reporter_name'),
  // UI locale at submission — the language of the receipt + decision
  // notice emails.
  reporterLocale: text('reporter_locale'),
  // When the reporter confirmed the good-faith statement (Art.16(2)(d)).
  goodFaithConfirmedAt: timestamp('good_faith_confirmed_at', { withTimezone: true }),
  // Truncated IP + user-agent hash, only to detect one actor flooding reports.
  reporterIpTruncated: text('reporter_ip_truncated'),
  reporterUserAgentHash: text('reporter_user_agent_hash'),
  // `other` is the catch-all and requires a body.
  category: text('category', {
    enum: ['illegal_content', 'copyright', 'csam', 'harassment', 'spam', 'other']
  }).notNull(),
  body: text('body').notNull(),
  status: text('status', {
    enum: ['open', 'acknowledged', 'actioned', 'dismissed']
  }).notNull().default('open'),
  // Moderator who handled the report; `set null` keeps the record when
  // the account goes.
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
  // Triage queue, oldest first; per-doc lookup.
  index('idx_abuse_reports_status').on(table.status, table.createdAt),
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

// GDPR Art. 20 data-export jobs. A request enqueues a row; a worker
// streams a ZIP to S3 and emails a presigned URL valid until
// `expiresAt`, after which the sweeper purges the row and the blob.
//
// At most one active job per user (checked on `status IN ('queued',
// 'running')` before enqueueing), so repeated POSTs can't amplify cost.
//
// Cascades with the user; `accountDeletionSweep` also removes the S3 object.
export const dataExportJobs = pgTable('data_export_jobs', {
  id: serial('id').primaryKey(),
  jobId: text('job_id').notNull().unique(),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  status: text('status', {
    enum: ['queued', 'running', 'ready', 'expired', 'failed']
  }).notNull().default('queued'),
  // Set once the worker uploads the ZIP.
  s3Key: text('s3_key'),
  // Worker error on failure, shown in the export-history list.
  errorMessage: text('error_message'),
  sizeBytes: integer('size_bytes'),
  // 7 days after `ready`. Exports are never extended, since the data may
  // have changed; renewal is a new job.
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true })
}, table => [
  index('idx_data_export_jobs_user').on(table.userId, table.createdAt.desc()),
  index('idx_data_export_jobs_status').on(table.status, table.createdAt)
])

// MCP Personal Access Tokens: long-lived bearer tokens external MCP
// clients send in `Authorization: Bearer <token>` to /mcp.
//
// Stored SHA-256-hashed; the plaintext is shown once on creation. Each
// request's header is hashed and looked up against `tokenHash`; hits are
// Valkey-cached for 60s.
//
// Cascades with the user. Revocation (`revokedAt`) is a soft delete: the
// row stays for audit but the verifier rejects it. `expiresAt` is
// optional (null = no expiry).
//
// Scopes are a subset of `documents:read | documents:write |
// knowledge:read | web:fetch`; per-tool `enabled` guards in
// server/mcp/tools/*.ts check membership.
export const mcpPersonalTokens = pgTable('mcp_personal_tokens', {
  id: serial('id').primaryKey(),
  // Public handle (`mkt_pat_<nanoid>`) used in API responses and
  // DELETE /api/mcp/tokens/:tokenId; distinct from `id` so URLs don't
  // reveal row counts or creation order.
  tokenId: text('token_id').notNull().unique(),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  // User-supplied label, ≤80 chars (validated in the API).
  name: text('name').notNull(),
  // Hex SHA-256 of the plaintext `mkt_<32-char-base32>` token, which is
  // never stored or logged.
  tokenHash: text('token_hash').notNull().unique(),
  // Granted scopes; tools gate on `enabled: event => hasScope(event, '...')`.
  scopes: text('scopes').array().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  // Bumped on successful authentication, at most once a minute (Valkey)
  // to avoid hot-row contention.
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  // Soft delete; the verifier rejects any row where this is set.
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  // Null = never expires (manual revocation only).
  expiresAt: timestamp('expires_at', { withTimezone: true })
}, table => [
  // The unique `tokenHash` already indexes the verifier lookup.
  index('idx_mcp_personal_tokens_user').on(table.userId, table.createdAt.desc())
])

// MCP sessions: one row per client connection, assigned at `initialize`
// and stable across its tool calls. `activity_log` rows from MCP edits
// carry the principal `mcp:{mcpSessionId}`; this table resolves it to the
// human and the credential. Join chain:
//
//   activity_log.user_id = 'mcp:{mcpSessionId}'
//     → mcp_sessions.mcp_session_id  (strip 'mcp:' prefix)
//       → mcp_sessions.user_id       → users.id (the human)
//       → mcp_sessions.token_id      → mcp_personal_tokens (which credential)
//
// Writer: `touchMcpSession` in `server/utils/mcp/mcpAuth.ts` (MCP
// middleware): INSERT … ON CONFLICT DO UPDATE bumps `last_active_at`,
// throttled to once a minute by Valkey.
//
// user_id cascades with the user. token_id is SET NULL when the PAT is
// hard-deleted, so the session stays joinable to user_id; soft revocation
// keeps the link.
export const mcpSessions = pgTable('mcp_sessions', {
  id: serial('id').primaryKey(),
  // UUID from the `Mcp-Session-Id` response header, without the `mcp:`
  // prefix activity_log uses.
  mcpSessionId: text('mcp_session_id').notNull().unique(),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  // Which PAT minted this session (by `tokenId`, not the serial `id`).
  tokenId: text('token_id').references(() => mcpPersonalTokens.tokenId, { onDelete: 'set null' }),
  // `clientInfo.name` from the initialize call ("Claude Desktop", "Cursor").
  // NULL if that call wasn't seen: the session id only appears from the
  // second call on.
  clientName: text('client_name'),
  // User-Agent of the first request carrying the session id; not updated.
  userAgent: text('user_agent'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  // Bumped on authenticated tool calls, at most once a minute (Valkey).
  lastActiveAt: timestamp('last_active_at', { withTimezone: true }).notNull().defaultNow()
}, table => [
  index('idx_mcp_sessions_user').on(table.userId, table.lastActiveAt.desc()),
  // Every session that used a PAT (leaked-token triage).
  index('idx_mcp_sessions_token').on(table.tokenId)
])

// Paid-plans waitlist. Only active while billing is OFF and the
// deployment advertises upcoming plans (`NUXT_PLANS_COMING_SOON`). Lawful
// basis: consent (GDPR Art.6(1)(a) / FADP Art.6(6)) — see
// `server/legal/lawfulBasis.ts#paid_plans_waitlist`.
//
// Double opt-in: a row is written UNCONFIRMED on signup and only counts
// once `confirmed_at` is set via the emailed confirm link. Unconfirmed
// rows are reaped by `server/utils/privacy/waitlistSweep.ts` after the confirm
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

// Bring-your-own-key AI provider configs. One row per user per
// capability (`chat` | `image` | `transcription`). Every LLM call for
// that capability is routed through LiteLLM's zero-cost `byok/*`
// deployment with these values as clientside credentials, so the
// user's own provider account pays and the platform AI budget is not
// touched. See `server/utils/aiProviders/` + docs/AI-MODELS.md.
//
//   - `api_key_encrypted` uses the same AES-256-GCM scheme as the
//     LiteLLM virtual-key tokens (`server/utils/platform/secretBox.ts`,
//     own HKDF key from NUXT_ENCRYPTION_KEY, bound to user + capability). The plaintext is never returned to
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
