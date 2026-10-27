ALTER TABLE "uploads" ADD COLUMN "gc_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "uploads" ADD COLUMN "unreferenced_since" timestamp with time zone;