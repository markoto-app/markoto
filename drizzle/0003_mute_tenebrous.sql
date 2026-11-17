CREATE TABLE "tax_evidence" (
	"id" serial PRIMARY KEY NOT NULL,
	"stripe_object_id" text NOT NULL,
	"kind" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"stripe_payment_intent_id" text,
	"billing_country" text,
	"billing_state" text,
	"ip_country" text,
	"card_country" text,
	"decided_country" text,
	"evidence" text NOT NULL,
	"tax_id_stripe_id" text,
	"tax_id_type" text,
	"tax_id_value" text,
	"tax_id_verification" text,
	"tax_id_removed_at" timestamp with time zone,
	"outcome" text DEFAULT 'accepted' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tax_evidence_stripe_object_id_unique" UNIQUE("stripe_object_id")
);
--> statement-breakpoint
CREATE INDEX "idx_tax_evidence_customer" ON "tax_evidence" USING btree ("stripe_customer_id");--> statement-breakpoint
CREATE INDEX "idx_tax_evidence_subject" ON "tax_evidence" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "idx_tax_evidence_created_at" ON "tax_evidence" USING btree ("created_at");