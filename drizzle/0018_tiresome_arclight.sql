CREATE TABLE "waitlist_signups" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"locale" text NOT NULL,
	"consent_version" integer NOT NULL,
	"consent_text_id" text NOT NULL,
	"user_id" integer,
	"confirm_token_hash" text,
	"confirm_token_expires_at" timestamp with time zone,
	"unsubscribe_token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone,
	CONSTRAINT "waitlist_signups_email_unique" UNIQUE("email"),
	CONSTRAINT "waitlist_signups_confirm_token_hash_unique" UNIQUE("confirm_token_hash"),
	CONSTRAINT "waitlist_signups_unsubscribe_token_hash_unique" UNIQUE("unsubscribe_token_hash")
);
--> statement-breakpoint
ALTER TABLE "waitlist_signups" ADD CONSTRAINT "waitlist_signups_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_waitlist_signups_user" ON "waitlist_signups" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_waitlist_signups_unconfirmed" ON "waitlist_signups" USING btree ("confirm_token_expires_at") WHERE "waitlist_signups"."confirmed_at" IS NULL;