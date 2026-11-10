CREATE TABLE "document_view_days" (
	"doc_id" text NOT NULL,
	"day" date NOT NULL,
	"opens" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "document_view_days_doc_id_day_pk" PRIMARY KEY("doc_id","day")
);
--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "share_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "share_no_download" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "document_view_days" ADD CONSTRAINT "document_view_days_doc_id_documents_doc_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."documents"("doc_id") ON DELETE cascade ON UPDATE no action;