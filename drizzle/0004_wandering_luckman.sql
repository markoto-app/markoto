-- Admin product stats. Both indexes are plain CREATE INDEX: documents and
-- activity_log are small on every current deployment (one write lock of a
-- few hundred milliseconds at most). On a large instance, build them out of
-- band first with CREATE INDEX CONCURRENTLY under the same names; IF NOT
-- EXISTS then skips them here.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "last_active_on" date;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_documents_created" ON "documents" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_activity_created_user" ON "activity_log" USING btree ("created_at","user_id") WHERE user_id IS NOT NULL;
