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
-- Backfill: `workspace` and `billing` events carry the workspace id as
-- their scope id; document events get the document's CURRENT workspace
-- (events of documents deleted since keep NULL — they stay in the
-- operator's record, just not in a workspace's viewer).
ALTER TABLE "audit_log" ADD COLUMN "workspace_id" text;--> statement-breakpoint
UPDATE "audit_log" SET "workspace_id" = "scope_id" WHERE "scope" IN ('workspace', 'billing');--> statement-breakpoint
UPDATE "audit_log" a SET "workspace_id" = d."workspace_id" FROM "documents" d WHERE a."scope" = 'doc' AND a."scope_id" = d."doc_id" AND d."workspace_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_audit_workspace" ON "audit_log" USING btree ("workspace_id","ts" DESC NULLS LAST);
