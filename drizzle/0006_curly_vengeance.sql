CREATE TABLE "themes" (
	"id" serial PRIMARY KEY NOT NULL,
	"theme_id" text NOT NULL,
	"user_id" integer NOT NULL,
	"name" text NOT NULL,
	"theme" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "themes_theme_id_unique" UNIQUE("theme_id")
);
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "default_theme" jsonb;--> statement-breakpoint
ALTER TABLE "themes" ADD CONSTRAINT "themes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_themes_user" ON "themes" USING btree ("user_id");