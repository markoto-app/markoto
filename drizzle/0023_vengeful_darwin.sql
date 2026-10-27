CREATE TABLE "ai_session_provenance" (
	"session_id" text PRIMARY KEY NOT NULL,
	"doc_id" text NOT NULL,
	"user_id" integer NOT NULL,
	"clean" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_session_provenance" ADD CONSTRAINT "ai_session_provenance_doc_id_documents_doc_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."documents"("doc_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_session_provenance" ADD CONSTRAINT "ai_session_provenance_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_ai_session_provenance_user" ON "ai_session_provenance" USING btree ("user_id");