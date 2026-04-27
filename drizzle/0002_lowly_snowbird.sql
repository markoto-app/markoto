CREATE TABLE "document_comments" (
	"doc_id" text NOT NULL,
	"entry_id" text NOT NULL,
	"parent_comment_id" text,
	"author_id" integer,
	"author_name" text NOT NULL,
	"body" text NOT NULL,
	"created_at_ms" timestamp with time zone NOT NULL,
	"updated_at_ms" timestamp with time zone NOT NULL,
	"resolved" boolean DEFAULT false NOT NULL,
	"orphaned" boolean DEFAULT false NOT NULL,
	CONSTRAINT "document_comments_doc_id_entry_id_pk" PRIMARY KEY("doc_id","entry_id")
);
--> statement-breakpoint
ALTER TABLE "document_comments" ADD CONSTRAINT "document_comments_doc_id_documents_doc_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."documents"("doc_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_comments" ADD CONSTRAINT "document_comments_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_document_comments_author" ON "document_comments" USING btree ("author_id");--> statement-breakpoint
CREATE INDEX "idx_document_comments_updated" ON "document_comments" USING btree ("updated_at_ms");