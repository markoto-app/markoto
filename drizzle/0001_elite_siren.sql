ALTER TABLE "users" ADD COLUMN "billing_interval" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "plan_cancel_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspace_subscriptions" ADD COLUMN "cancel_at" timestamp with time zone;