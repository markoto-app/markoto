CREATE TABLE "pending_stripe_events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"customer_id" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed" boolean DEFAULT false NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "processed_webhook_events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_pse_customer_unprocessed" ON "pending_stripe_events" USING btree ("customer_id","processed","received_at");--> statement-breakpoint
CREATE INDEX "idx_pse_received_at" ON "pending_stripe_events" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "idx_pwe_processed_at" ON "processed_webhook_events" USING btree ("processed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_activity_doc_yjsafter" ON "activity_log" USING btree ("doc_id","yjs_doc_id_after") WHERE yjs_doc_id_after IS NOT NULL AND action IN ('edit', 'title.changed', 'theme.changed');