// Audit log, consent log, abuse reports with moderation notices, data-export jobs.

import { pgTable, serial, integer, text, timestamp, index, jsonb, boolean } from 'drizzle-orm/pg-core'
import type { AuditAfter, AuditBefore, AuditMetadata } from '../columnTypes'
import { users } from './users'

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
  // Art.16(2)(b) "exact electronic location"), usually the document
  // URL. `doc_id` is what we could parse out of it.
  contentUrl: text('content_url'),
  // Signed-in reporter; NULL for email-channel reports. `set null` on user
  // delete: the report stays actionable evidence.
  reporterUserId: integer('reporter_user_id').references(() => users.id, { onDelete: 'set null' }),
  reporterEmail: text('reporter_email'),
  // Reporter's name as typed in the form (Art.16(2)(c); optional for
  // CSAM reports). Signed-in reporters default to their profile name.
  reporterName: text('reporter_name'),
  // UI locale at submission, the language of the receipt + decision
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
// exact text: the record of what we told whom (DSA Art.16(4)
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
