-- pgvector extension must exist before any `vector(…)` column is
-- created further down. drizzle-kit doesn't emit CREATE EXTENSION;
-- hand-prepended here so a fresh DB boot works out of the box.
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TABLE "activity_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"doc_id" text NOT NULL,
	"user_name" text,
	"action" text NOT NULL,
	"word_count" integer,
	"lines_added" integer,
	"lines_removed" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_sessions" (
	"session_id" text PRIMARY KEY NOT NULL,
	"doc_id" text NOT NULL,
	"initiator_user_id" integer NOT NULL,
	"initiator_name" text NOT NULL,
	"initiator_color" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_usage_period" (
	"attributed_to" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"interactions_used" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_usage_period_attributed_to_period_start_pk" PRIMARY KEY("attributed_to","period_start")
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" serial PRIMARY KEY NOT NULL,
	"doc_id" text NOT NULL,
	"owner_id" integer,
	"workspace_id" text,
	"title" text DEFAULT 'Untitled' NOT NULL,
	"access_mode" text DEFAULT 'open-edit' NOT NULL,
	"password_hash" text,
	"size_bytes" integer DEFAULT 0,
	"word_count" integer DEFAULT 0,
	"theme" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_active" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documents_doc_id_unique" UNIQUE("doc_id")
);
--> statement-breakpoint
CREATE TABLE "uploads" (
	"id" serial PRIMARY KEY NOT NULL,
	"doc_id" text NOT NULL,
	"file_id" text NOT NULL,
	"uploader_id" integer,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"s3_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone,
	CONSTRAINT "uploads_s3_key_unique" UNIQUE("s3_key")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"github_id" text,
	"google_id" text,
	"login" text,
	"name" text NOT NULL,
	"email" text,
	"avatar_url" text,
	"plan" text DEFAULT 'free' NOT NULL,
	"plan_valid_until" timestamp with time zone,
	"stripe_current_period_start" timestamp with time zone,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_github_id_unique" UNIQUE("github_id"),
	CONSTRAINT "users_google_id_unique" UNIQUE("google_id"),
	CONSTRAINT "users_stripe_customer_id_unique" UNIQUE("stripe_customer_id"),
	CONSTRAINT "users_stripe_subscription_id_unique" UNIQUE("stripe_subscription_id")
);
--> statement-breakpoint
CREATE TABLE "workspace_knowledge" (
	"id" serial PRIMARY KEY NOT NULL,
	"knowledge_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"filename" text NOT NULL,
	"source_ext" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"s3_key" text NOT NULL,
	"markdown_cache" text,
	"status" text DEFAULT 'processing' NOT NULL,
	"error_message" text,
	"chunk_count" integer DEFAULT 0 NOT NULL,
	"token_count" integer DEFAULT 0 NOT NULL,
	"embedding_version" text NOT NULL,
	"uploader_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "workspace_knowledge_knowledge_id_unique" UNIQUE("knowledge_id"),
	CONSTRAINT "workspace_knowledge_s3_key_unique" UNIQUE("s3_key")
);
--> statement-breakpoint
CREATE TABLE "workspace_knowledge_chunks" (
	"id" serial PRIMARY KEY NOT NULL,
	"knowledge_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"chunk_index" integer NOT NULL,
	"content" text NOT NULL,
	"tokens" integer NOT NULL,
	"embedding" vector(768),
	"content_tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', "workspace_knowledge_chunks"."content")) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_members" (
	"workspace_id" text NOT NULL,
	"user_id" integer NOT NULL,
	"role" text DEFAULT 'editor' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_members_workspace_id_user_id_pk" PRIMARY KEY("workspace_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" serial PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"owner_id" integer NOT NULL,
	"name" text DEFAULT 'My Workspace' NOT NULL,
	"description" text,
	"billing_owner_id" integer,
	"ai_enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspaces_workspace_id_unique" UNIQUE("workspace_id")
);
--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_doc_id_documents_doc_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."documents"("doc_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_sessions" ADD CONSTRAINT "ai_sessions_initiator_user_id_users_id_fk" FOREIGN KEY ("initiator_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_workspace_id_workspaces_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_doc_id_documents_doc_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."documents"("doc_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_uploader_id_users_id_fk" FOREIGN KEY ("uploader_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_knowledge" ADD CONSTRAINT "workspace_knowledge_workspace_id_workspaces_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_knowledge" ADD CONSTRAINT "workspace_knowledge_uploader_id_users_id_fk" FOREIGN KEY ("uploader_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_knowledge_chunks" ADD CONSTRAINT "workspace_knowledge_chunks_knowledge_id_workspace_knowledge_knowledge_id_fk" FOREIGN KEY ("knowledge_id") REFERENCES "public"."workspace_knowledge"("knowledge_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_workspaces_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_billing_owner_id_users_id_fk" FOREIGN KEY ("billing_owner_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_activity_doc" ON "activity_log" USING btree ("doc_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_sessions_user_doc_unq" ON "ai_sessions" USING btree ("initiator_user_id","doc_id");--> statement-breakpoint
CREATE INDEX "idx_ai_sessions_started_at" ON "ai_sessions" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "idx_documents_owner" ON "documents" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "idx_documents_last_active" ON "documents" USING btree ("last_active");--> statement-breakpoint
CREATE INDEX "idx_documents_workspace" ON "documents" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_uploads_doc" ON "uploads" USING btree ("doc_id");--> statement-breakpoint
CREATE INDEX "idx_uploads_unconfirmed" ON "uploads" USING btree ("confirmed_at","created_at");--> statement-breakpoint
CREATE INDEX "idx_users_plan_valid_until" ON "users" USING btree ("plan_valid_until") WHERE "users"."plan_valid_until" is not null;--> statement-breakpoint
CREATE INDEX "idx_wk_workspace" ON "workspace_knowledge" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_wk_status_created" ON "workspace_knowledge" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "wk_workspace_filename_unq" ON "workspace_knowledge" USING btree ("workspace_id","filename");--> statement-breakpoint
CREATE INDEX "idx_wkc_knowledge" ON "workspace_knowledge_chunks" USING btree ("knowledge_id");--> statement-breakpoint
CREATE INDEX "idx_wkc_workspace" ON "workspace_knowledge_chunks" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_wkc_embedding" ON "workspace_knowledge_chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "idx_wkc_content_tsv" ON "workspace_knowledge_chunks" USING gin ("content_tsv");--> statement-breakpoint
CREATE INDEX "idx_workspace_members_user" ON "workspace_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_workspaces_owner" ON "workspaces" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "idx_workspaces_billing_owner" ON "workspaces" USING btree ("billing_owner_id");