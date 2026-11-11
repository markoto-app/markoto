ALTER TABLE "documents" ADD COLUMN "moderation_restricted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "moderation_report_id" text;