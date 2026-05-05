-- Workstream A of the EU privacy / GDPR / ePrivacy / DSA / AI-Act
-- compliance plan. Adds:
--
--   * three new tables (abuse_reports, consent_log, data_export_jobs);
--   * ten new nullable columns on users (locale, age confirmation,
--     deletion grace window, accepted version of TOS / privacy / DPA
--     plus the locale each was viewed in);
--   * one partial index on users(deletion_grace_until).
--
-- All user-table column additions are NULLABLE on purpose — we cannot
-- backfill age_confirmed_at or accepted-policy versions retroactively
-- (we never asked existing users), so the app code forces a re-prompt
-- on next login for grandfathered accounts. Nullable adds do not
-- rewrite the table.
--
-- The new partial index on users(deletion_grace_until) WHERE
-- deletion_grace_until IS NOT NULL is created without CONCURRENTLY
-- because (a) the users table is small at our current scale, and
-- (b) the partial-index predicate is false for every existing row,
-- so the index is empty at creation and the SHARE lock is sub-ms.
-- Recipe 3 in server/db/AGENTS.md applies if/when this index needs
-- to be re-created on a much larger users table — switch to
-- CONCURRENTLY in its own migration file at that point.

CREATE TABLE "abuse_reports" (
	"id" serial PRIMARY KEY NOT NULL,
	"report_id" text NOT NULL,
	"doc_id" text,
	"reporter_email" text,
	"reporter_ip_truncated" text,
	"reporter_user_agent_hash" text,
	"category" text NOT NULL,
	"body" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"actioned_by" integer,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"actioned_at" timestamp with time zone,
	CONSTRAINT "abuse_reports_report_id_unique" UNIQUE("report_id")
);
--> statement-breakpoint
CREATE TABLE "consent_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer,
	"anon_id" text NOT NULL,
	"purpose" text NOT NULL,
	"granted" boolean NOT NULL,
	"version" integer NOT NULL,
	"locale" text NOT NULL,
	"ip_truncated" text,
	"user_agent_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "data_export_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"user_id" integer NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"s3_key" text,
	"error_message" text,
	"size_bytes" integer,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "data_export_jobs_job_id_unique" UNIQUE("job_id")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "locale" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "age_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "deletion_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "deletion_grace_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "tos_version_accepted" integer;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "tos_version_accepted_locale" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "privacy_version_accepted" integer;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "privacy_version_accepted_locale" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "dpa_version_accepted" integer;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "dpa_version_accepted_locale" text;--> statement-breakpoint
ALTER TABLE "abuse_reports" ADD CONSTRAINT "abuse_reports_doc_id_documents_doc_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."documents"("doc_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "abuse_reports" ADD CONSTRAINT "abuse_reports_actioned_by_users_id_fk" FOREIGN KEY ("actioned_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_log" ADD CONSTRAINT "consent_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_export_jobs" ADD CONSTRAINT "data_export_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_abuse_reports_status" ON "abuse_reports" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "idx_abuse_reports_doc" ON "abuse_reports" USING btree ("doc_id");--> statement-breakpoint
CREATE INDEX "idx_consent_log_user" ON "consent_log" USING btree ("user_id","purpose","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_consent_log_anon" ON "consent_log" USING btree ("anon_id","purpose","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_data_export_jobs_user" ON "data_export_jobs" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_data_export_jobs_status" ON "data_export_jobs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "idx_users_deletion_grace_until" ON "users" USING btree ("deletion_grace_until") WHERE "users"."deletion_grace_until" is not null;