CREATE TABLE "mcp_sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"mcp_session_id" text NOT NULL,
	"user_id" integer NOT NULL,
	"token_id" text,
	"client_name" text,
	"user_agent" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_active_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_sessions_mcp_session_id_unique" UNIQUE("mcp_session_id")
);
--> statement-breakpoint
ALTER TABLE "mcp_sessions" ADD CONSTRAINT "mcp_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_sessions" ADD CONSTRAINT "mcp_sessions_token_id_mcp_personal_tokens_token_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."mcp_personal_tokens"("token_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_mcp_sessions_user" ON "mcp_sessions" USING btree ("user_id","last_active_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_mcp_sessions_token" ON "mcp_sessions" USING btree ("token_id");