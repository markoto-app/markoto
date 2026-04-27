-- Wipe all existing documents + their per-doc satellite data before
-- adding the four new NOT NULL columns. This migration ships with
-- explicit consent from the user — at the time it was authored there
-- was no doc data worth preserving and adding NOT NULL columns to a
-- non-empty table would require a backfill we don't want to write.
-- Future migrations should NOT use this pattern; do a proper backfill
-- instead.
--
-- Cascade scope (everything that references documents.doc_id or stores
-- per-doc state outside the documents row):
--   - documents (CASCADE drops uploads + activity_log via FK)
--   - yjs_documents (y-postgresql persistence — no FK to documents,
--     and the table is created LAZILY at first sync-server connect
--     rather than by a drizzle migration; the IF EXISTS guards make
--     this migration safe on a fresh DB where the table doesn't yet)
--   - ai_sessions (orphaned without their docs; no FK)
--
-- Workspaces, members, users, knowledge files, and ai_usage_period are
-- workspace/user-scoped and survive the wipe.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'documents') THEN
    TRUNCATE TABLE "documents" RESTART IDENTITY CASCADE;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'yjs_documents') THEN
    TRUNCATE TABLE "yjs_documents" RESTART IDENTITY CASCADE;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'ai_sessions') THEN
    TRUNCATE TABLE "ai_sessions" RESTART IDENTITY CASCADE;
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "description" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "audience" text DEFAULT 'casual' NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "language" text DEFAULT 'en' NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "template_id" text DEFAULT 'blank' NOT NULL;
