ALTER TABLE "ai_credit_settlements" ADD COLUMN "plan_budget_usd" double precision;--> statement-breakpoint
ALTER TABLE "workspace_subscriptions" ADD COLUMN "budget_seat_adjust" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_subscriptions" ADD COLUMN "budget_seat_adjust_until" timestamp with time zone;