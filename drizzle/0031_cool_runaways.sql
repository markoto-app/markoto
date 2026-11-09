CREATE TABLE "ai_credit_grants" (
	"id" serial PRIMARY KEY NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"pack" text NOT NULL,
	"amount_usd" double precision NOT NULL,
	"remaining_usd" double precision NOT NULL,
	"refunded_usd" double precision DEFAULT 0 NOT NULL,
	"amount_paid" integer NOT NULL,
	"currency" text NOT NULL,
	"stripe_payment_intent_id" text NOT NULL,
	"stripe_checkout_session_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_credit_grants_stripe_payment_intent_id_unique" UNIQUE("stripe_payment_intent_id")
);
--> statement-breakpoint
CREATE TABLE "ai_credit_settlements" (
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"period" text NOT NULL,
	"consumed_usd" double precision DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_credit_settlements_subject_type_subject_id_period_pk" PRIMARY KEY("subject_type","subject_id","period")
);
--> statement-breakpoint
CREATE INDEX "idx_ai_credit_grants_subject" ON "ai_credit_grants" USING btree ("subject_type","subject_id");