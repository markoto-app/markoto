CREATE TABLE "custom_domains" (
	"id" text PRIMARY KEY NOT NULL,
	"hostname" text NOT NULL,
	"user_id" integer NOT NULL,
	"page_id" text,
	"verify_token" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"last_error" text,
	"verified_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "published_pages" (
	"id" text PRIMARY KEY NOT NULL,
	"doc_id" text NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"html" text NOT NULL,
	"css" text NOT NULL,
	"fonts_import" text DEFAULT '' NOT NULL,
	"hljs_url" text,
	"indexable" boolean DEFAULT false NOT NULL,
	"published_by_user_id" integer,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "published_pages_doc_id_unique" UNIQUE("doc_id"),
	CONSTRAINT "published_pages_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "custom_domains" ADD CONSTRAINT "custom_domains_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_domains" ADD CONSTRAINT "custom_domains_page_id_published_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."published_pages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_pages" ADD CONSTRAINT "published_pages_doc_id_documents_doc_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."documents"("doc_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_pages" ADD CONSTRAINT "published_pages_published_by_user_id_users_id_fk" FOREIGN KEY ("published_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_custom_domains_user" ON "custom_domains" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_custom_domains_page" ON "custom_domains" USING btree ("page_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_custom_domains_verified_host" ON "custom_domains" USING btree ("hostname") WHERE "custom_domains"."status" = 'verified';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_custom_domains_user_host" ON "custom_domains" USING btree ("user_id","hostname");