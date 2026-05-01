-- audit_log: new table + two btree indexes. Plain CREATE INDEX is fine
-- here because the table starts empty — there's nothing to scan.
--
-- For FUTURE indexes on populated tables (e.g. activity_log, yjs_documents,
-- workspace_knowledge_chunks once they have prod rows), hand-edit the
-- generated SQL to CREATE INDEX CONCURRENTLY. CONCURRENTLY can't run
-- inside a transaction, so the migration must also drop its implicit
-- transaction wrapping. See server/AGENTS.md "Drizzle conventions".
CREATE TABLE "audit_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_user_id" integer,
	"actor_ip" text,
	"scope" text NOT NULL,
	"scope_id" text,
	"action" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"metadata" jsonb
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_audit_scope" ON "audit_log" USING btree ("scope","scope_id","ts" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_audit_actor" ON "audit_log" USING btree ("actor_user_id","ts" DESC NULLS LAST);