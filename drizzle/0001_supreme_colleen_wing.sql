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
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_doc_id_documents_doc_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."documents"("doc_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_uploader_id_users_id_fk" FOREIGN KEY ("uploader_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_uploads_doc" ON "uploads" USING btree ("doc_id");--> statement-breakpoint
CREATE INDEX "idx_uploads_unconfirmed" ON "uploads" USING btree ("confirmed_at","created_at");