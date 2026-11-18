-- Hand-written (drizzle-kit never emits CREATE EXTENSION): pg_trgm backs the
-- typo-tolerant title search (`idx_document_search_title_trgm` below). It
-- ships with the pgvector image and with OVH managed Postgres.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE TABLE "folders" (
	"id" serial PRIMARY KEY NOT NULL,
	"folder_id" text NOT NULL,
	"workspace_id" text,
	"owner_id" integer,
	"parent_id" text,
	"name" text NOT NULL,
	"position" text DEFAULT '' NOT NULL,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "folders_folder_id_unique" UNIQUE("folder_id"),
	CONSTRAINT "ck_folders_one_scope" CHECK (num_nonnulls("folders"."workspace_id", "folders"."owner_id") = 1)
);
--> statement-breakpoint
CREATE TABLE "document_search" (
	"doc_id" text PRIMARY KEY NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"body_tsv" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('simple'::regconfig, "document_search"."title"), 'A') || setweight(to_tsvector('simple'::regconfig, "document_search"."body"), 'B')) STORED,
	"yjs_id" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_job_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"item_id" text NOT NULL,
	"relative_path" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text,
	"doc_id" text,
	"s3_key" text,
	"size_bytes" bigint DEFAULT 0 NOT NULL,
	"images_skipped" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "import_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"user_id" integer NOT NULL,
	"workspace_id" text,
	"target_folder_id" text,
	"source" text NOT NULL,
	"source_ref" text,
	"status" text DEFAULT 'uploading' NOT NULL,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"done" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"skipped" integer DEFAULT 0 NOT NULL,
	"total_bytes" bigint DEFAULT 0 NOT NULL,
	"error" text,
	"heartbeat_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "import_jobs_job_id_unique" UNIQUE("job_id")
);
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "folder_id" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
-- Hand-written: existing documents start with their last activity as "last edited".
UPDATE "documents" SET "updated_at" = "last_active";--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_workspace_id_workspaces_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_parent_id_folders_folder_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."folders"("folder_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_search" ADD CONSTRAINT "document_search_doc_id_documents_doc_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."documents"("doc_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_job_items" ADD CONSTRAINT "import_job_items_job_id_import_jobs_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."import_jobs"("job_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_job_items" ADD CONSTRAINT "import_job_items_doc_id_documents_doc_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."documents"("doc_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_workspace_id_workspaces_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD CONSTRAINT "import_jobs_target_folder_id_folders_folder_id_fk" FOREIGN KEY ("target_folder_id") REFERENCES "public"."folders"("folder_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_folders_sibling_name" ON "folders" USING btree (coalesce("workspace_id", ''),coalesce("owner_id", 0),coalesce("parent_id", ''),lower("name"));--> statement-breakpoint
CREATE INDEX "idx_folders_workspace_parent" ON "folders" USING btree ("workspace_id","parent_id");--> statement-breakpoint
CREATE INDEX "idx_folders_owner_parent" ON "folders" USING btree ("owner_id","parent_id");--> statement-breakpoint
CREATE INDEX "idx_folders_parent" ON "folders" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "idx_document_search_tsv" ON "document_search" USING gin ("body_tsv");--> statement-breakpoint
CREATE INDEX "idx_document_search_title_trgm" ON "document_search" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_import_job_items_item" ON "import_job_items" USING btree ("job_id","item_id");--> statement-breakpoint
CREATE INDEX "idx_import_job_items_job_status" ON "import_job_items" USING btree ("job_id","status");--> statement-breakpoint
CREATE INDEX "idx_import_jobs_user_created" ON "import_jobs" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_import_jobs_status" ON "import_jobs" USING btree ("status","heartbeat_at");--> statement-breakpoint
CREATE INDEX "idx_import_jobs_workspace" ON "import_jobs" USING btree ("workspace_id","created_at");--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_folder_id_folders_folder_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("folder_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_documents_workspace_folder" ON "documents" USING btree ("workspace_id","folder_id");--> statement-breakpoint
CREATE INDEX "idx_documents_owner_folder" ON "documents" USING btree ("owner_id","folder_id");