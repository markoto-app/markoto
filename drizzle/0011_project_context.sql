CREATE TABLE "document_context_links" (
	"doc_id" text NOT NULL,
	"context_doc_id" text NOT NULL,
	"added_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_context_links_doc_id_context_doc_id_pk" PRIMARY KEY("doc_id","context_doc_id")
);
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "context_scope" text;--> statement-breakpoint
ALTER TABLE "document_context_links" ADD CONSTRAINT "document_context_links_doc_id_documents_doc_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."documents"("doc_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_context_links" ADD CONSTRAINT "document_context_links_context_doc_id_documents_doc_id_fk" FOREIGN KEY ("context_doc_id") REFERENCES "public"."documents"("doc_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_context_links" ADD CONSTRAINT "document_context_links_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_document_context_links_context" ON "document_context_links" USING btree ("context_doc_id");--> statement-breakpoint
CREATE INDEX "idx_documents_context" ON "documents" USING btree ("workspace_id","owner_id") WHERE "documents"."context_scope" IS NOT NULL;--> statement-breakpoint
-- Marking a document as project context changes its explorer badge: open
-- explorers refetch on it like on a rename.
CREATE OR REPLACE TRIGGER trg_documents_explorer_update AFTER UPDATE ON documents
  FOR EACH ROW WHEN (
    OLD.title IS DISTINCT FROM NEW.title OR OLD.folder_id IS DISTINCT FROM NEW.folder_id
    OR OLD.workspace_id IS DISTINCT FROM NEW.workspace_id OR OLD.owner_id IS DISTINCT FROM NEW.owner_id
    OR OLD.access_mode IS DISTINCT FROM NEW.access_mode
    OR OLD.context_scope IS DISTINCT FROM NEW.context_scope
  ) EXECUTE FUNCTION markoto_explorer_change();
