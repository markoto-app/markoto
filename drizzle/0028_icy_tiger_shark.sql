-- Pricing WP1: Free / Pro / Team / Business. Max and Ultra are retired;
-- billing has never been switched on, so no customer holds them. Any row
-- left from a test period moves to Pro (the closest personal plan) — the
-- previous release still accepts 'pro', so a code rollback stays safe.
UPDATE "users" SET "plan" = 'pro' WHERE "plan" IN ('max', 'ultra');--> statement-breakpoint
CREATE TABLE "workspace_subscriptions" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"plan" text NOT NULL,
	"seats" integer NOT NULL,
	"status" text NOT NULL,
	"billing_admin_id" integer,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"current_period_start" timestamp with time zone,
	"valid_until" timestamp with time zone,
	"litellm_team_id" text,
	"currency" text DEFAULT 'eur' NOT NULL,
	"interval" text DEFAULT 'month' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_subscriptions_stripe_subscription_id_unique" UNIQUE("stripe_subscription_id")
);
--> statement-breakpoint
ALTER TABLE "workspace_subscriptions" ADD CONSTRAINT "workspace_subscriptions_workspace_id_workspaces_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_subscriptions" ADD CONSTRAINT "workspace_subscriptions_billing_admin_id_users_id_fk" FOREIGN KEY ("billing_admin_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_workspace_subscriptions_billing_admin" ON "workspace_subscriptions" USING btree ("billing_admin_id");--> statement-breakpoint
CREATE INDEX "idx_workspace_subscriptions_customer" ON "workspace_subscriptions" USING btree ("stripe_customer_id");