CREATE TABLE "ai_usage_period" (
	"attributed_to" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"interactions_used" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_usage_period_attributed_to_period_start_pk" PRIMARY KEY("attributed_to","period_start")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "plan" text DEFAULT 'free' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "plan_valid_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "stripe_customer_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "stripe_subscription_id" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "billing_owner_id" integer;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "ai_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_billing_owner_id_users_id_fk" FOREIGN KEY ("billing_owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_users_plan_valid_until" ON "users" USING btree ("plan_valid_until") WHERE "users"."plan_valid_until" is not null;--> statement-breakpoint
CREATE INDEX "idx_workspaces_billing_owner" ON "workspaces" USING btree ("billing_owner_id");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_stripe_customer_id_unique" UNIQUE("stripe_customer_id");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_stripe_subscription_id_unique" UNIQUE("stripe_subscription_id");