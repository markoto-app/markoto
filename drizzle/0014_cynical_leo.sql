ALTER TABLE "ai_usage_period" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "ai_usage_period" CASCADE;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "litellm_key_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "litellm_key_token" text;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_litellm_key_id_unique" UNIQUE("litellm_key_id");