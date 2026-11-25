ALTER TABLE "users" ADD COLUMN "acquisition_source" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "checkout_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "acquisition_source" text;