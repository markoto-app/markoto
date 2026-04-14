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
CREATE TABLE "document_shares" (
	"id" serial PRIMARY KEY NOT NULL,
	"doc_id" text NOT NULL,
	"user_id" integer NOT NULL,
	"role" text DEFAULT 'editor' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" serial PRIMARY KEY NOT NULL,
	"doc_id" text NOT NULL,
	"owner_id" integer,
	"title" text DEFAULT 'Untitled' NOT NULL,
	"access_mode" text DEFAULT 'open-edit' NOT NULL,
	"password_hash" text,
	"size_bytes" integer DEFAULT 0,
	"word_count" integer DEFAULT 0,
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
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_github_id_unique" UNIQUE("github_id"),
	CONSTRAINT "users_google_id_unique" UNIQUE("google_id")
);
--> statement-breakpoint
CREATE TABLE "workspace_documents" (
	"workspace_id" text NOT NULL,
	"doc_id" text NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_documents_workspace_id_doc_id_pk" PRIMARY KEY("workspace_id","doc_id")
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" serial PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"owner_id" integer NOT NULL,
	"name" text DEFAULT 'My Workspace' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspaces_workspace_id_unique" UNIQUE("workspace_id")
);
--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_doc_id_documents_doc_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."documents"("doc_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_sessions" ADD CONSTRAINT "ai_sessions_initiator_user_id_users_id_fk" FOREIGN KEY ("initiator_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_shares" ADD CONSTRAINT "document_shares_doc_id_documents_doc_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."documents"("doc_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_shares" ADD CONSTRAINT "document_shares_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_doc_id_documents_doc_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."documents"("doc_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_uploader_id_users_id_fk" FOREIGN KEY ("uploader_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_documents" ADD CONSTRAINT "workspace_documents_workspace_id_workspaces_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_documents" ADD CONSTRAINT "workspace_documents_doc_id_documents_doc_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."documents"("doc_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_activity_doc" ON "activity_log" USING btree ("doc_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_sessions_user_doc_unq" ON "ai_sessions" USING btree ("initiator_user_id","doc_id");--> statement-breakpoint
CREATE INDEX "idx_ai_sessions_started_at" ON "ai_sessions" USING btree ("started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_share_unique" ON "document_shares" USING btree ("doc_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_documents_owner" ON "documents" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "idx_documents_last_active" ON "documents" USING btree ("last_active");--> statement-breakpoint
CREATE INDEX "idx_uploads_doc" ON "uploads" USING btree ("doc_id");--> statement-breakpoint
CREATE INDEX "idx_uploads_unconfirmed" ON "uploads" USING btree ("confirmed_at","created_at");