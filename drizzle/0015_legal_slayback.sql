CREATE TABLE "mcp_personal_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"token_id" text NOT NULL,
	"user_id" integer NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"scopes" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	CONSTRAINT "mcp_personal_tokens_token_id_unique" UNIQUE("token_id"),
	CONSTRAINT "mcp_personal_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "mcp_personal_tokens" ADD CONSTRAINT "mcp_personal_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_mcp_personal_tokens_user" ON "mcp_personal_tokens" USING btree ("user_id","created_at" DESC NULLS LAST);