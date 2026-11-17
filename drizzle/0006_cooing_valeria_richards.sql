CREATE TABLE "ad_click_conversions" (
	"id" serial PRIMARY KEY NOT NULL,
	"click_id_type" text NOT NULL,
	"click_id" text NOT NULL,
	"conversion" text NOT NULL,
	"user_id" integer,
	"waitlist_signup_id" integer,
	"converted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"uploaded_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "ad_click_conversions" ADD CONSTRAINT "ad_click_conversions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ad_click_conversions" ADD CONSTRAINT "ad_click_conversions_waitlist_signup_id_waitlist_signups_id_fk" FOREIGN KEY ("waitlist_signup_id") REFERENCES "public"."waitlist_signups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_ad_click_conversions_click_kind" ON "ad_click_conversions" USING btree ("click_id","conversion");--> statement-breakpoint
CREATE INDEX "idx_ad_click_conversions_user" ON "ad_click_conversions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_ad_click_conversions_waitlist" ON "ad_click_conversions" USING btree ("waitlist_signup_id");--> statement-breakpoint
CREATE INDEX "idx_ad_click_conversions_converted_at" ON "ad_click_conversions" USING btree ("converted_at");--> statement-breakpoint
CREATE INDEX "idx_ad_click_conversions_pending" ON "ad_click_conversions" USING btree ("converted_at") WHERE "ad_click_conversions"."uploaded_at" IS NULL;