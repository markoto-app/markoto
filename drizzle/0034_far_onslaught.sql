-- WP15: workspace audit-log viewer + export.
--
-- `audit_log.workspace_id` (nullable, no FK — the record outlives the
-- workspace) + an index for the viewer's "this workspace, newest first".
--
-- The index is created WITHOUT CONCURRENTLY (server/db/AGENTS.md,
-- Recipe 3): audit_log is small on every deployment today (2-year
-- retention, events only on security-relevant actions — a few thousand
-- rows on the hosted service), so the SHARE lock is held for well under
-- a second. Re-create it CONCURRENTLY in its own file if that changes.
--
-- Backfill: only `workspace` and `billing` events, which carry the
-- workspace id as their scope id. Older document events are NOT
-- backfilled: a document's current workspace is not the workspace it was
-- in when the event happened (moves, formerly personal documents), and
-- the doc scope also holds operator moderation decisions, which a
-- customer admin must not see. They stay in the operator's record; new
-- document events get the workspace at the time from appendAuditEvent.
ALTER TABLE "audit_log" ADD COLUMN "workspace_id" text;--> statement-breakpoint
UPDATE "audit_log" SET "workspace_id" = "scope_id" WHERE "scope" IN ('workspace', 'billing');--> statement-breakpoint
CREATE INDEX "idx_audit_workspace" ON "audit_log" USING btree ("workspace_id","ts" DESC NULLS LAST);
