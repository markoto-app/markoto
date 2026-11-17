CREATE TABLE "ai_job_units" (
	"job_id" text NOT NULL,
	"ordinal" integer NOT NULL,
	"heading_path" text NOT NULL,
	"start_rel" text NOT NULL,
	"end_rel" text NOT NULL,
	"rev_before" text NOT NULL,
	"unit_tokens" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"before_text" text,
	"after_hash" text,
	"output" jsonb,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"tokens_in" integer DEFAULT 0 NOT NULL,
	"tokens_out" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_job_units_job_id_ordinal_pk" PRIMARY KEY("job_id","ordinal")
);
--> statement-breakpoint
CREATE TABLE "ai_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"doc_id" text NOT NULL,
	"initiator_user_id" integer NOT NULL,
	"workspace_id" text,
	"session_id" text,
	"mode" text NOT NULL,
	"status" text DEFAULT 'preview' NOT NULL,
	"params" jsonb NOT NULL,
	"estimate" jsonb,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"cost_known" boolean DEFAULT true NOT NULL,
	"tokens_in" integer DEFAULT 0 NOT NULL,
	"tokens_out" integer DEFAULT 0 NOT NULL,
	"units_total" integer DEFAULT 0 NOT NULL,
	"units_done" integer DEFAULT 0 NOT NULL,
	"units_skipped" integer DEFAULT 0 NOT NULL,
	"units_flagged" integer DEFAULT 0 NOT NULL,
	"units_retried" integer DEFAULT 0 NOT NULL,
	"worker_model" text,
	"reason" text,
	"current_heading" text,
	"heartbeat_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "ai_job_units" ADD CONSTRAINT "ai_job_units_job_id_ai_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."ai_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_jobs" ADD CONSTRAINT "ai_jobs_doc_id_documents_doc_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."documents"("doc_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_jobs" ADD CONSTRAINT "ai_jobs_initiator_user_id_users_id_fk" FOREIGN KEY ("initiator_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_ai_job_units_job_status" ON "ai_job_units" USING btree ("job_id","status","ordinal");--> statement-breakpoint
CREATE INDEX "idx_ai_jobs_doc_created" ON "ai_jobs" USING btree ("doc_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_ai_jobs_user_created" ON "ai_jobs" USING btree ("initiator_user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_ai_jobs_status_heartbeat" ON "ai_jobs" USING btree ("status","heartbeat_at");