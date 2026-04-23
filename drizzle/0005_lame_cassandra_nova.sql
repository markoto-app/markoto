-- pgvector extension. Drizzle doesn't emit CREATE EXTENSION for us;
-- must precede any `vector(...)` column declaration. Idempotent so
-- reruns on an already-enabled DB are no-ops.
CREATE EXTENSION IF NOT EXISTS vector;
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
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace_knowledge" ADD CONSTRAINT "workspace_knowledge_workspace_id_workspaces_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_knowledge" ADD CONSTRAINT "workspace_knowledge_uploader_id_users_id_fk" FOREIGN KEY ("uploader_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_knowledge_chunks" ADD CONSTRAINT "workspace_knowledge_chunks_knowledge_id_workspace_knowledge_knowledge_id_fk" FOREIGN KEY ("knowledge_id") REFERENCES "public"."workspace_knowledge"("knowledge_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_wk_workspace" ON "workspace_knowledge" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_wk_status_created" ON "workspace_knowledge" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "wk_workspace_filename_unq" ON "workspace_knowledge" USING btree ("workspace_id","filename");--> statement-breakpoint
CREATE INDEX "idx_wkc_knowledge" ON "workspace_knowledge_chunks" USING btree ("knowledge_id");--> statement-breakpoint
CREATE INDEX "idx_wkc_workspace" ON "workspace_knowledge_chunks" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_wkc_embedding" ON "workspace_knowledge_chunks" USING hnsw ("embedding" vector_cosine_ops);