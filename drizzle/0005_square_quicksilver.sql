CREATE TABLE "subscription_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"subject_type" text NOT NULL,
	"user_id" integer,
	"workspace_id" text,
	"plan" text NOT NULL,
	"interval" text NOT NULL,
	"currency" text NOT NULL,
	"seats" integer DEFAULT 1 NOT NULL,
	"stripe_subscription_id" text,
	"stripe_event_id" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_spend_daily" (
	"day" date NOT NULL,
	"feature" text NOT NULL,
	"model" text NOT NULL,
	"platform_paid" boolean NOT NULL,
	"spend_usd" double precision NOT NULL,
	"requests" integer NOT NULL,
	"users" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_spend_daily_day_feature_model_platform_paid_pk" PRIMARY KEY("day","feature","model","platform_paid")
);
--> statement-breakpoint
ALTER TABLE "subscription_events" ADD CONSTRAINT "subscription_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_subscription_events_event_kind" ON "subscription_events" USING btree ("stripe_event_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_subscription_events_sub_once" ON "subscription_events" USING btree ("stripe_subscription_id","kind") WHERE kind IN ('started', 'ended');--> statement-breakpoint
CREATE INDEX "idx_subscription_events_occurred" ON "subscription_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "idx_subscription_events_user" ON "subscription_events" USING btree ("user_id");--> statement-breakpoint
-- Backfill: what the workspace subscription rows already tell (their start,
-- and their end when they ended). Pro subscriptions keep no history on the
-- user row, so their history starts with this migration.
INSERT INTO "subscription_events" ("kind", "subject_type", "workspace_id", "plan", "interval", "currency", "seats", "stripe_subscription_id", "occurred_at")
SELECT 'started', 'workspace', "workspace_id", "plan", "interval", "currency", "seats", "stripe_subscription_id", "created_at"
FROM "workspace_subscriptions";--> statement-breakpoint
INSERT INTO "subscription_events" ("kind", "subject_type", "workspace_id", "plan", "interval", "currency", "seats", "stripe_subscription_id", "occurred_at")
SELECT 'ended', 'workspace', "workspace_id", "plan", "interval", "currency", "seats", "stripe_subscription_id", "updated_at"
FROM "workspace_subscriptions" WHERE "status" IN ('canceled', 'incomplete_expired');
