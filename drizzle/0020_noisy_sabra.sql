ALTER TABLE "users" ADD COLUMN "oidc_issuer" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "oidc_subject" text;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_users_oidc_identity" ON "users" USING btree ("oidc_issuer","oidc_subject");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "ck_users_oidc_identity_pair" CHECK (("users"."oidc_issuer" is null) = ("users"."oidc_subject" is null));