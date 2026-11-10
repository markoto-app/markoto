CREATE TABLE "workspace_brand_assets" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"kind" text NOT NULL,
	"format" text NOT NULL,
	"name" text NOT NULL,
	"weight" integer,
	"style" text,
	"size_bytes" integer NOT NULL,
	"s3_key" text NOT NULL,
	"uploaded_by" integer,
	"licence_confirmed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"doc_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"created_by" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "brand_locked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_brand_assets" ADD CONSTRAINT "workspace_brand_assets_workspace_id_workspaces_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_brand_assets" ADD CONSTRAINT "workspace_brand_assets_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_templates" ADD CONSTRAINT "workspace_templates_workspace_id_workspaces_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_templates" ADD CONSTRAINT "workspace_templates_doc_id_documents_doc_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."documents"("doc_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_templates" ADD CONSTRAINT "workspace_templates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_brand_assets_workspace" ON "workspace_brand_assets" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_brand_font_face" ON "workspace_brand_assets" USING btree ("workspace_id","name","weight","style") WHERE kind = 'font';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_workspace_template_doc" ON "workspace_templates" USING btree ("workspace_id","doc_id");--> statement-breakpoint
CREATE INDEX "idx_workspace_templates_doc" ON "workspace_templates" USING btree ("doc_id");