-- Hand-written (drizzle-kit never emits CREATE EXTENSION): pgvector must
-- exist before `workspace_knowledge_chunks.embedding vector(768)` and its
-- HNSW index below. Every other statement in this file is generated from
-- server/db/schema.ts.
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TABLE "abuse_reports" (
	"id" serial PRIMARY KEY NOT NULL,
	"report_id" text NOT NULL,
	"doc_id" text,
	"content_url" text,
	"reporter_user_id" integer,
	"reporter_email" text,
	"reporter_name" text,
	"reporter_locale" text,
	"good_faith_confirmed_at" timestamp with time zone,
	"reporter_ip_truncated" text,
	"reporter_user_agent_hash" text,
	"category" text NOT NULL,
	"body" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"actioned_by" integer,
	"notes" text,
	"decision_action" text,
	"decision_rule" text,
	"decision_explanation" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"actioned_at" timestamp with time zone,
	CONSTRAINT "abuse_reports_report_id_unique" UNIQUE("report_id")
);
--> statement-breakpoint
CREATE TABLE "activity_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"doc_id" text NOT NULL,
	"user_id" integer,
	"user_name" text,
	"action" text NOT NULL,
	"word_count" integer,
	"lines_added" integer,
	"lines_removed" integer,
	"metadata" jsonb,
	"yjs_doc_id_before" integer,
	"yjs_doc_id_after" integer,
	"actor_principal" text,
	"actor_avatar_seed" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_credit_grants" (
	"id" serial PRIMARY KEY NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"pack" text NOT NULL,
	"amount_usd" double precision NOT NULL,
	"remaining_usd" double precision NOT NULL,
	"refunded_usd" double precision DEFAULT 0 NOT NULL,
	"amount_paid" integer NOT NULL,
	"currency" text NOT NULL,
	"stripe_payment_intent_id" text NOT NULL,
	"stripe_checkout_session_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_credit_grants_stripe_payment_intent_id_unique" UNIQUE("stripe_payment_intent_id")
);
--> statement-breakpoint
CREATE TABLE "ai_credit_settlements" (
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"period" text NOT NULL,
	"consumed_usd" double precision DEFAULT 0 NOT NULL,
	"plan_budget_usd" double precision,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_credit_settlements_subject_type_subject_id_period_pk" PRIMARY KEY("subject_type","subject_id","period")
);
--> statement-breakpoint
CREATE TABLE "ai_session_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"doc_id" text NOT NULL,
	"user_id" integer NOT NULL,
	"session_id" text NOT NULL,
	"kind" text NOT NULL,
	"body" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_session_provenance" (
	"session_id" text PRIMARY KEY NOT NULL,
	"doc_id" text NOT NULL,
	"user_id" integer NOT NULL,
	"clean" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_sessions" (
	"session_id" text PRIMARY KEY NOT NULL,
	"doc_id" text NOT NULL,
	"initiator_user_id" integer NOT NULL,
	"initiator_name" text NOT NULL,
	"initiator_color" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_user_id" integer,
	"actor_ip" text,
	"scope" text NOT NULL,
	"scope_id" text,
	"action" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"metadata" jsonb,
	"workspace_id" text
);
--> statement-breakpoint
CREATE TABLE "consent_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer,
	"anon_id" text NOT NULL,
	"purpose" text NOT NULL,
	"granted" boolean NOT NULL,
	"version" integer NOT NULL,
	"locale" text NOT NULL,
	"ip_truncated" text,
	"user_agent_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
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
CREATE TABLE "data_export_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"user_id" integer NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"s3_key" text,
	"error_message" text,
	"size_bytes" integer,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "data_export_jobs_job_id_unique" UNIQUE("job_id")
);
--> statement-breakpoint
CREATE TABLE "document_comments" (
	"doc_id" text NOT NULL,
	"entry_id" text NOT NULL,
	"parent_comment_id" text,
	"author_id" integer,
	"author_name" text NOT NULL,
	"body" text NOT NULL,
	"created_at_ms" timestamp with time zone NOT NULL,
	"updated_at_ms" timestamp with time zone NOT NULL,
	"resolved" boolean DEFAULT false NOT NULL,
	"orphaned" boolean DEFAULT false NOT NULL,
	CONSTRAINT "document_comments_doc_id_entry_id_pk" PRIMARY KEY("doc_id","entry_id")
);
--> statement-breakpoint
CREATE TABLE "document_shares" (
	"doc_id" text NOT NULL,
	"user_id" integer NOT NULL,
	"access" text NOT NULL,
	"granted_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_shares_doc_id_user_id_pk" PRIMARY KEY("doc_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "document_view_days" (
	"doc_id" text NOT NULL,
	"day" date NOT NULL,
	"opens" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "document_view_days_doc_id_day_pk" PRIMARY KEY("doc_id","day")
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" serial PRIMARY KEY NOT NULL,
	"doc_id" text NOT NULL,
	"owner_id" integer,
	"workspace_id" text,
	"title" text DEFAULT 'Untitled' NOT NULL,
	"access_mode" text DEFAULT 'open-edit' NOT NULL,
	"password_hash" text,
	"share_expires_at" timestamp with time zone,
	"share_no_download" boolean DEFAULT false NOT NULL,
	"moderation_restricted_at" timestamp with time zone,
	"moderation_report_id" text,
	"size_bytes" integer DEFAULT 0,
	"word_count" integer DEFAULT 0,
	"theme" jsonb,
	"description" text DEFAULT '' NOT NULL,
	"audience" text DEFAULT 'casual' NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"template_id" text DEFAULT 'blank' NOT NULL,
	"anon_creator_key_hash" text,
	"anon_terms_version" integer,
	"anon_terms_accepted_at" timestamp with time zone,
	"sweep_not_before" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_active" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documents_doc_id_unique" UNIQUE("doc_id")
);
--> statement-breakpoint
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
CREATE TABLE "moderation_notices" (
	"id" serial PRIMARY KEY NOT NULL,
	"notice_id" text NOT NULL,
	"report_id" text NOT NULL,
	"kind" text NOT NULL,
	"recipient_role" text NOT NULL,
	"recipient_user_id" integer,
	"status" text NOT NULL,
	"locale" text NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "moderation_notices_notice_id_unique" UNIQUE("notice_id")
);
--> statement-breakpoint
CREATE TABLE "pending_stripe_events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"customer_id" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed" boolean DEFAULT false NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "processed_webhook_events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL
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
CREATE TABLE "sso_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"protocol" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"oidc_issuer" text,
	"oidc_client_id" text,
	"oidc_client_secret" text,
	"saml_idp_entity_id" text,
	"saml_sso_url" text,
	"saml_idp_cert" text,
	"default_role" text DEFAULT 'editor' NOT NULL,
	"scim_token_hash" text,
	"created_by_user_id" integer,
	"activated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sso_connections_workspace_id_unique" UNIQUE("workspace_id"),
	CONSTRAINT "sso_connections_scim_token_hash_unique" UNIQUE("scim_token_hash")
);
--> statement-breakpoint
CREATE TABLE "sso_domains" (
	"id" serial PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"domain" text NOT NULL,
	"verification_token" text NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sso_grants" (
	"user_id" integer NOT NULL,
	"workspace_id" text NOT NULL,
	"session_epoch" integer NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "sso_grants_user_id_workspace_id_pk" PRIMARY KEY("user_id","workspace_id")
);
--> statement-breakpoint
CREATE TABLE "themes" (
	"id" serial PRIMARY KEY NOT NULL,
	"theme_id" text NOT NULL,
	"user_id" integer NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"theme" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "themes_theme_id_unique" UNIQUE("theme_id")
);
--> statement-breakpoint
CREATE TABLE "uploads" (
	"id" serial PRIMARY KEY NOT NULL,
	"doc_id" text NOT NULL,
	"file_id" text NOT NULL,
	"uploader_id" integer,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"s3_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone,
	"gc_checked_at" timestamp with time zone,
	"unreferenced_since" timestamp with time zone,
	CONSTRAINT "uploads_s3_key_unique" UNIQUE("s3_key")
);
--> statement-breakpoint
CREATE TABLE "user_ai_providers" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"capability" text NOT NULL,
	"base_url" text NOT NULL,
	"model" text NOT NULL,
	"api_key_encrypted" text NOT NULL,
	"api_key_last4" text NOT NULL,
	"supports_vision" boolean DEFAULT false NOT NULL,
	"supports_tools" boolean,
	"last_verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_identities" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"connection_id" text NOT NULL,
	"subject" text NOT NULL,
	"scim_external_id" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"github_id" text,
	"google_id" text,
	"oidc_issuer" text,
	"oidc_subject" text,
	"login" text,
	"name" text NOT NULL,
	"email" text,
	"plan" text DEFAULT 'free' NOT NULL,
	"plan_valid_until" timestamp with time zone,
	"stripe_current_period_start" timestamp with time zone,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"billing_currency" text,
	"ai_model_tier" text DEFAULT 'fast' NOT NULL,
	"litellm_key_id" text,
	"litellm_key_token" text,
	"is_admin" boolean DEFAULT false NOT NULL,
	"locale" text,
	"age_confirmed_at" timestamp with time zone,
	"deletion_requested_at" timestamp with time zone,
	"deletion_grace_until" timestamp with time zone,
	"tos_version_accepted" integer,
	"tos_version_accepted_locale" text,
	"privacy_version_accepted" integer,
	"privacy_version_accepted_locale" text,
	"dpa_version_accepted" integer,
	"dpa_version_accepted_locale" text,
	"session_epoch" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_github_id_unique" UNIQUE("github_id"),
	CONSTRAINT "users_google_id_unique" UNIQUE("google_id"),
	CONSTRAINT "users_stripe_customer_id_unique" UNIQUE("stripe_customer_id"),
	CONSTRAINT "users_stripe_subscription_id_unique" UNIQUE("stripe_subscription_id"),
	CONSTRAINT "users_litellm_key_id_unique" UNIQUE("litellm_key_id"),
	CONSTRAINT "ck_users_oidc_identity_pair" CHECK (("users"."oidc_issuer" is null) = ("users"."oidc_subject" is null))
);
--> statement-breakpoint
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
CREATE TABLE "workspace_invites" (
	"id" serial PRIMARY KEY NOT NULL,
	"invite_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text DEFAULT 'editor' NOT NULL,
	"invited_by_user_id" integer,
	"token_hash" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_invites_invite_id_unique" UNIQUE("invite_id"),
	CONSTRAINT "workspace_invites_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "workspace_knowledge" (
	"id" serial PRIMARY KEY NOT NULL,
	"knowledge_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"filename" text NOT NULL,
	"source_ext" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"s3_key" text NOT NULL,
	"markdown_cache" text,
	"status" text DEFAULT 'processing' NOT NULL,
	"error_message" text,
	"chunk_count" integer DEFAULT 0 NOT NULL,
	"token_count" integer DEFAULT 0 NOT NULL,
	"embedding_version" text NOT NULL,
	"uploader_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "workspace_knowledge_knowledge_id_unique" UNIQUE("knowledge_id"),
	CONSTRAINT "workspace_knowledge_s3_key_unique" UNIQUE("s3_key")
);
--> statement-breakpoint
CREATE TABLE "workspace_knowledge_chunks" (
	"id" serial PRIMARY KEY NOT NULL,
	"knowledge_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"chunk_index" integer NOT NULL,
	"content" text NOT NULL,
	"tokens" integer NOT NULL,
	"embedding" vector(768),
	"content_tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', "workspace_knowledge_chunks"."content")) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_members" (
	"workspace_id" text NOT NULL,
	"user_id" integer NOT NULL,
	"role" text DEFAULT 'editor' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ai_limit_usd" double precision,
	"ai_unlimited" boolean DEFAULT false NOT NULL,
	"litellm_key_id" text,
	"litellm_key_token" text,
	CONSTRAINT "workspace_members_workspace_id_user_id_pk" PRIMARY KEY("workspace_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "workspace_subscriptions" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"plan" text NOT NULL,
	"seats" integer NOT NULL,
	"status" text NOT NULL,
	"billing_admin_id" integer,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"current_period_start" timestamp with time zone,
	"valid_until" timestamp with time zone,
	"litellm_team_id" text,
	"budget_seat_adjust" double precision DEFAULT 0 NOT NULL,
	"budget_seat_adjust_until" timestamp with time zone,
	"currency" text DEFAULT 'eur' NOT NULL,
	"interval" text DEFAULT 'month' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_subscriptions_stripe_subscription_id_unique" UNIQUE("stripe_subscription_id")
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
CREATE TABLE "workspaces" (
	"id" serial PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"owner_id" integer NOT NULL,
	"name" text DEFAULT 'My Workspace' NOT NULL,
	"description" text,
	"default_theme" jsonb,
	"brand_locked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspaces_workspace_id_unique" UNIQUE("workspace_id")
);
--> statement-breakpoint
ALTER TABLE "abuse_reports" ADD CONSTRAINT "abuse_reports_reporter_user_id_users_id_fk" FOREIGN KEY ("reporter_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "abuse_reports" ADD CONSTRAINT "abuse_reports_actioned_by_users_id_fk" FOREIGN KEY ("actioned_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_doc_id_documents_doc_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."documents"("doc_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_session_messages" ADD CONSTRAINT "ai_session_messages_doc_id_documents_doc_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."documents"("doc_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_session_messages" ADD CONSTRAINT "ai_session_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_session_provenance" ADD CONSTRAINT "ai_session_provenance_doc_id_documents_doc_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."documents"("doc_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_session_provenance" ADD CONSTRAINT "ai_session_provenance_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_sessions" ADD CONSTRAINT "ai_sessions_initiator_user_id_users_id_fk" FOREIGN KEY ("initiator_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_log" ADD CONSTRAINT "consent_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_domains" ADD CONSTRAINT "custom_domains_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_domains" ADD CONSTRAINT "custom_domains_page_id_published_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."published_pages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_export_jobs" ADD CONSTRAINT "data_export_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_comments" ADD CONSTRAINT "document_comments_doc_id_documents_doc_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."documents"("doc_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_comments" ADD CONSTRAINT "document_comments_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_shares" ADD CONSTRAINT "document_shares_doc_id_documents_doc_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."documents"("doc_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_shares" ADD CONSTRAINT "document_shares_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_shares" ADD CONSTRAINT "document_shares_granted_by_user_id_users_id_fk" FOREIGN KEY ("granted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_view_days" ADD CONSTRAINT "document_view_days_doc_id_documents_doc_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."documents"("doc_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_workspace_id_workspaces_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_personal_tokens" ADD CONSTRAINT "mcp_personal_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_sessions" ADD CONSTRAINT "mcp_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_sessions" ADD CONSTRAINT "mcp_sessions_token_id_mcp_personal_tokens_token_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."mcp_personal_tokens"("token_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_notices" ADD CONSTRAINT "moderation_notices_report_id_abuse_reports_report_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."abuse_reports"("report_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moderation_notices" ADD CONSTRAINT "moderation_notices_recipient_user_id_users_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_pages" ADD CONSTRAINT "published_pages_doc_id_documents_doc_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."documents"("doc_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_pages" ADD CONSTRAINT "published_pages_published_by_user_id_users_id_fk" FOREIGN KEY ("published_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_connections" ADD CONSTRAINT "sso_connections_workspace_id_workspaces_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_connections" ADD CONSTRAINT "sso_connections_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_domains" ADD CONSTRAINT "sso_domains_workspace_id_workspaces_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_grants" ADD CONSTRAINT "sso_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sso_grants" ADD CONSTRAINT "sso_grants_workspace_id_workspaces_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "themes" ADD CONSTRAINT "themes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_doc_id_documents_doc_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."documents"("doc_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_uploader_id_users_id_fk" FOREIGN KEY ("uploader_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_ai_providers" ADD CONSTRAINT "user_ai_providers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_connection_id_sso_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."sso_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_signups" ADD CONSTRAINT "waitlist_signups_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_brand_assets" ADD CONSTRAINT "workspace_brand_assets_workspace_id_workspaces_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_brand_assets" ADD CONSTRAINT "workspace_brand_assets_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_invites" ADD CONSTRAINT "workspace_invites_workspace_id_workspaces_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_invites" ADD CONSTRAINT "workspace_invites_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_knowledge" ADD CONSTRAINT "workspace_knowledge_workspace_id_workspaces_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_knowledge" ADD CONSTRAINT "workspace_knowledge_uploader_id_users_id_fk" FOREIGN KEY ("uploader_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_knowledge_chunks" ADD CONSTRAINT "workspace_knowledge_chunks_knowledge_id_workspace_knowledge_knowledge_id_fk" FOREIGN KEY ("knowledge_id") REFERENCES "public"."workspace_knowledge"("knowledge_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_workspaces_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_subscriptions" ADD CONSTRAINT "workspace_subscriptions_workspace_id_workspaces_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_subscriptions" ADD CONSTRAINT "workspace_subscriptions_billing_admin_id_users_id_fk" FOREIGN KEY ("billing_admin_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_templates" ADD CONSTRAINT "workspace_templates_workspace_id_workspaces_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_templates" ADD CONSTRAINT "workspace_templates_doc_id_documents_doc_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."documents"("doc_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_templates" ADD CONSTRAINT "workspace_templates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_abuse_reports_status" ON "abuse_reports" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "idx_abuse_reports_doc" ON "abuse_reports" USING btree ("doc_id");--> statement-breakpoint
CREATE INDEX "idx_activity_doc" ON "activity_log" USING btree ("doc_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_activity_actor_principal" ON "activity_log" USING btree ("actor_principal") WHERE actor_principal IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_activity_doc_yjsafter" ON "activity_log" USING btree ("doc_id","yjs_doc_id_after") WHERE yjs_doc_id_after IS NOT NULL AND action IN ('edit', 'title.changed', 'theme.changed');--> statement-breakpoint
CREATE INDEX "idx_ai_credit_grants_subject" ON "ai_credit_grants" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "idx_ai_msg_doc_user_time" ON "ai_session_messages" USING btree ("doc_id","user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_ai_session_provenance_user" ON "ai_session_provenance" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_sessions_user_doc_unq" ON "ai_sessions" USING btree ("initiator_user_id","doc_id");--> statement-breakpoint
CREATE INDEX "idx_ai_sessions_started_at" ON "ai_sessions" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "idx_audit_scope" ON "audit_log" USING btree ("scope","scope_id","ts" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_audit_actor" ON "audit_log" USING btree ("actor_user_id","ts" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_audit_workspace" ON "audit_log" USING btree ("workspace_id","ts" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_consent_log_user" ON "consent_log" USING btree ("user_id","purpose","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_consent_log_anon" ON "consent_log" USING btree ("anon_id","purpose","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_custom_domains_user" ON "custom_domains" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_custom_domains_page" ON "custom_domains" USING btree ("page_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_custom_domains_verified_host" ON "custom_domains" USING btree ("hostname") WHERE "custom_domains"."status" = 'verified';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_custom_domains_user_host" ON "custom_domains" USING btree ("user_id","hostname");--> statement-breakpoint
CREATE INDEX "idx_data_export_jobs_user" ON "data_export_jobs" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_data_export_jobs_status" ON "data_export_jobs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "idx_document_comments_author" ON "document_comments" USING btree ("author_id");--> statement-breakpoint
CREATE INDEX "idx_document_comments_updated" ON "document_comments" USING btree ("updated_at_ms");--> statement-breakpoint
CREATE INDEX "idx_document_shares_user" ON "document_shares" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_documents_owner" ON "documents" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "idx_documents_last_active" ON "documents" USING btree ("last_active");--> statement-breakpoint
CREATE INDEX "idx_documents_workspace" ON "documents" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_mcp_personal_tokens_user" ON "mcp_personal_tokens" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_mcp_sessions_user" ON "mcp_sessions" USING btree ("user_id","last_active_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_mcp_sessions_token" ON "mcp_sessions" USING btree ("token_id");--> statement-breakpoint
CREATE INDEX "idx_moderation_notices_report" ON "moderation_notices" USING btree ("report_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_pse_customer_unprocessed" ON "pending_stripe_events" USING btree ("customer_id","processed","received_at");--> statement-breakpoint
CREATE INDEX "idx_pse_received_at" ON "pending_stripe_events" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "idx_pwe_processed_at" ON "processed_webhook_events" USING btree ("processed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_sso_domains_ws_domain" ON "sso_domains" USING btree ("workspace_id","domain");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_sso_domains_verified" ON "sso_domains" USING btree ("domain") WHERE "sso_domains"."verified_at" is not null;--> statement-breakpoint
CREATE INDEX "idx_themes_user" ON "themes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_uploads_doc" ON "uploads" USING btree ("doc_id");--> statement-breakpoint
CREATE INDEX "idx_uploads_unconfirmed" ON "uploads" USING btree ("confirmed_at","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_user_ai_providers_user_capability" ON "user_ai_providers" USING btree ("user_id","capability");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_user_identities_conn_subject" ON "user_identities" USING btree ("connection_id","subject");--> statement-breakpoint
CREATE INDEX "idx_user_identities_user" ON "user_identities" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_users_plan_valid_until" ON "users" USING btree ("plan_valid_until") WHERE "users"."plan_valid_until" is not null;--> statement-breakpoint
CREATE INDEX "idx_users_deletion_grace_until" ON "users" USING btree ("deletion_grace_until") WHERE "users"."deletion_grace_until" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_users_oidc_identity" ON "users" USING btree ("oidc_issuer","oidc_subject");--> statement-breakpoint
CREATE INDEX "idx_waitlist_signups_user" ON "waitlist_signups" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_waitlist_signups_unconfirmed" ON "waitlist_signups" USING btree ("confirm_token_expires_at") WHERE "waitlist_signups"."confirmed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_brand_assets_workspace" ON "workspace_brand_assets" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_brand_font_face" ON "workspace_brand_assets" USING btree ("workspace_id","name","weight","style") WHERE kind = 'font';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_workspace_invites_ws_email" ON "workspace_invites" USING btree ("workspace_id","email");--> statement-breakpoint
CREATE INDEX "idx_workspace_invites_email" ON "workspace_invites" USING btree ("email");--> statement-breakpoint
CREATE INDEX "idx_workspace_invites_expires" ON "workspace_invites" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_wk_workspace" ON "workspace_knowledge" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_wk_status_created" ON "workspace_knowledge" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "wk_workspace_filename_unq" ON "workspace_knowledge" USING btree ("workspace_id","filename");--> statement-breakpoint
CREATE INDEX "idx_wkc_knowledge" ON "workspace_knowledge_chunks" USING btree ("knowledge_id");--> statement-breakpoint
CREATE INDEX "idx_wkc_workspace" ON "workspace_knowledge_chunks" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_wkc_embedding" ON "workspace_knowledge_chunks" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX "idx_wkc_content_tsv" ON "workspace_knowledge_chunks" USING gin ("content_tsv");--> statement-breakpoint
CREATE INDEX "idx_workspace_members_user" ON "workspace_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_workspace_subscriptions_billing_admin" ON "workspace_subscriptions" USING btree ("billing_admin_id");--> statement-breakpoint
CREATE INDEX "idx_workspace_subscriptions_customer" ON "workspace_subscriptions" USING btree ("stripe_customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_workspace_template_doc" ON "workspace_templates" USING btree ("workspace_id","doc_id");--> statement-breakpoint
CREATE INDEX "idx_workspace_templates_doc" ON "workspace_templates" USING btree ("doc_id");--> statement-breakpoint
CREATE INDEX "idx_workspaces_owner" ON "workspaces" USING btree ("owner_id");