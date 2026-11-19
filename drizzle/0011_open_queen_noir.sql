ALTER TABLE "users" ADD COLUMN "ai_suggest_edits" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "suggestion_policy" jsonb;