CREATE TABLE "ai_session_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"doc_id" text NOT NULL,
	"user_id" integer NOT NULL,
	"session_id" text NOT NULL,
	"kind" text NOT NULL,
	"body" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_session_messages" ADD CONSTRAINT "ai_session_messages_doc_id_documents_doc_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."documents"("doc_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_session_messages" ADD CONSTRAINT "ai_session_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_ai_msg_doc_user_time" ON "ai_session_messages" USING btree ("doc_id","user_id","created_at");