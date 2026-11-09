ALTER TABLE "workspace_members" ADD COLUMN "ai_limit_usd" double precision;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD COLUMN "ai_unlimited" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD COLUMN "litellm_key_id" text;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD COLUMN "litellm_key_token" text;