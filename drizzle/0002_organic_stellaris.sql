ALTER TABLE "workspace_documents" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "workspace_documents" CASCADE;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "workspace_id" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_workspace_id_workspaces_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_documents_workspace" ON "documents" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_workspaces_owner" ON "workspaces" USING btree ("owner_id");