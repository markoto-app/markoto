// Single source of truth for our GDPR Article 6 lawful-basis disclosure.
// The privacy policy page renders this table verbatim. Adding or
// changing a row is a privacy-policy material change → bump
// `PRIVACY_VERSION` in shared/legal/versions.ts.

// Article 6(1) lawful bases. We use these five; (c) legal-obligation
// is bundled into (b) contract for billing because Stripe handles the
// tax-record retention. (d) vital-interests and (e) public-task do
// not apply to a SaaS.
export type LawfulBasis
  = | 'contract' // Art. 6(1)(b)
    | 'legal_obligation' // Art. 6(1)(c)
    | 'legitimate_interest' // Art. 6(1)(f)
    | 'consent' // Art. 6(1)(a)

export type ProcessingPurpose = {
  // Stable id, used as the i18n key suffix and in audit-log metadata
  // when we record `policy.accepted` or `consent.recorded`.
  id: string
  // Short English label shown in the privacy policy's register table.
  label: string
  // Lawful basis under GDPR Article 6.
  basis: LawfulBasis
  // Categories of personal data touched. Free-form short labels;
  // referenced by the privacy policy page.
  dataCategories: string[]
  // Retention in days from last activity, or 'until_deletion' for
  // account-bound data, 'legal_minimum' for billing/tax, or
  // 'until_withdrawn' for consent-backed data kept until the person
  // withdraws consent (with an outer bound documented on the entry).
  retention: number | 'until_deletion' | 'legal_minimum' | 'until_withdrawn'
  // Sub-processor ids (from server/legal/subProcessors.ts) that touch
  // this purpose's data. Empty array = handled in-house only.
  subProcessors: string[]
}

export const PROCESSING_PURPOSES: readonly ProcessingPurpose[] = [
  {
    // `workspace_sso_identity`: signing in through a workspace's
    // own identity provider: the identifier it sends (OIDC subject /
    // SAML NameID), the link to the account, the last sign-in, a 12-hour
    // sign-in record per workspace, and what that workspace's SCIM
    // provisioning sent (external id, active / deactivated). Kept until
    // the link is removed (SCIM delete, connection removed, account
    // deleted).
    id: 'account_authentication',
    label: 'Sign-in and account',
    basis: 'contract',
    dataCategories: ['email', 'oauth_identifier', 'display_name', 'workspace_sso_identity'],
    retention: 'until_deletion',
    subProcessors: ['github_oauth', 'google_oauth']
  },
  {
    // `edit_attribution`: who changed a document, the activity log and
    // which user each in-editor AI session wrote for
    // (`ai_session_provenance`, read by the AI's safety checks). Kept as
    // long as the document / account.
    id: 'document_storage',
    label: 'Document storage',
    basis: 'contract',
    // `guest_document_shares`: which workspace documents were
    // shared with which guest (view / edit) and by whom.
    // `workspace_brand_kit`: fonts + logos a workspace's admins
    // uploaded (and who), workspace templates.
    dataCategories: ['document_content', 'document_metadata', 'images', 'edit_attribution', 'guest_document_shares', 'workspace_brand_kit'],
    retention: 'until_deletion',
    subProcessors: ['ovh_postgres', 'ovh_object_storage']
  },
  {
    // Published pages: a document published as a web page, the copy as published
    // (text, design, images, fonts), its address, who published it; and
    // custom domains (name, verification token, DNS check results). The
    // certificate for a custom domain comes from Let's Encrypt (the
    // domain name only; public in Certificate Transparency logs), the
    // customer's own request for a public HTTPS site, not processing of
    // document content.
    id: 'published_pages',
    label: 'Published web pages and custom domains',
    basis: 'contract',
    dataCategories: ['document_content', 'images', 'published_page_address', 'custom_domain'],
    retention: 'until_deletion',
    subProcessors: ['ovh_postgres', 'ovh_object_storage']
  },
  {
    id: 'collaboration_sync',
    label: 'Real-time collaboration',
    basis: 'contract',
    dataCategories: ['document_content', 'cursor_positions', 'awareness_state'],
    retention: 'until_deletion',
    subProcessors: ['ovh_postgres']
  },
  {
    id: 'comments_and_mentions',
    label: 'Comments and mentions',
    basis: 'contract',
    dataCategories: ['comment_body', 'author_name', 'mention_targets'],
    retention: 'until_deletion',
    subProcessors: ['ovh_postgres']
  },
  {
    // Includes the hosted free AI allowance (GLM-5.3 Flash on Mistral's EU
    // endpoint, monthly per-account limit + shared pool). The limits are
    // enforced from LiteLLM's per-request usage records (cost, model, time,
    // internal user ID), kept 90 days by `spend-logs-sweep`, the same
    // retention as the prompt / tool-call records.
    //
    // `uploaded_files`: "Create a design from a document" (theme panel)
    // sends the uploaded PDF / Word file's measured styles, first page
    // pictures and a short text sample to the AI. The file itself is read
    // in the sandboxed markitdown container and deleted from storage as
    // soon as the server has read it (never kept); the run's state lives
    // 30 minutes in Valkey.
    id: 'ai_assistance',
    label: 'AI writing assistant (platform providers, incl. the free AI allowance)',
    basis: 'contract',
    dataCategories: ['user_prompt', 'document_context', 'uploaded_files', 'ai_generated_content', 'ai_usage_records'],
    retention: 90,
    subProcessors: ['mistral_ai', 'jina_ai', 'bfl', 'staan']
  },
  {
    // Bring-your-own-key AI. When a user configures their OWN AI
    // provider (Settings → AI provider), their prompts, document
    // context, audio and generated content for that capability are sent
    // to the provider THEY chose, under THEIR agreement with that
    // provider, routed through our self-hosted LiteLLM proxy. markoto
    // does not choose that recipient, so it is deliberately NOT listed
    // as a sub-processor here; the user is the one directing the
    // transfer. What markoto itself processes is the provider config
    // (base URL, model, API key encrypted at rest), stored in our
    // database until the user removes it or deletes the account, and
    // the in-flight request. Prompt/tool-call records follow
    // `ai_assistance` retention (90 days).
    //
    // Exception: web search + page fetch (`web_search` / `fetch_url`) are
    // platform-provided for every user, BYOK included, queries go to Staan
    // and fetched URLs to Jina Reader on OUR accounts, so both are listed
    // below. The summarising step afterwards runs on the user's provider.
    id: 'user_directed_ai_provider',
    label: 'AI with your own provider (bring your own key)',
    basis: 'contract',
    dataCategories: ['provider_config', 'encrypted_api_key', 'user_prompt', 'document_context', 'uploaded_files', 'audio_recording', 'ai_generated_content'],
    retention: 'until_deletion',
    subProcessors: ['ovh_postgres', 'staan', 'jina_ai']
  },
  {
    id: 'workspace_knowledge_rag',
    label: 'Workspace knowledge base',
    basis: 'contract',
    dataCategories: ['uploaded_files', 'extracted_text', 'embeddings'],
    retention: 'until_deletion',
    subProcessors: ['jina_ai', 'ovh_postgres', 'ovh_object_storage']
  },
  {
    id: 'billing',
    label: 'Billing (only when paid plans are offered)',
    basis: 'contract',
    dataCategories: ['stripe_customer_id', 'subscription_state', 'invoice_history', 'workspace_subscription_billing_admin', 'workspace_member_ai_limits_and_spend', 'ai_credit_purchases'],
    retention: 'legal_minimum',
    subProcessors: ['stripe']
  },
  {
    id: 'fraud_and_abuse_prevention',
    label: 'Fraud and abuse prevention',
    basis: 'legitimate_interest',
    dataCategories: ['ip_truncated', 'user_agent_hash', 'rate_limit_counters'],
    retention: 90,
    subProcessors: []
  },
  {
    // `audit_log` is append-only; `audit-log-sweep` deletes rows older
    // than 2 years (`server/utils/privacy/legalRetentionSweep.ts`,
    // `NUXT_AUDIT_LOG_RETENTION_DAYS`). Account deletion nulls the actor
    // id earlier (FK `ON DELETE SET NULL`); the IP is stored truncated.
    // The entries about a workspace are also shown to (and
    // downloadable by) that workspace's admins when its plan includes
    // the audit log: names and the truncated IPs included.
    id: 'security_audit_log',
    label: 'Security audit log',
    basis: 'legal_obligation',
    dataCategories: ['actor_id', 'ip_truncated', 'action_metadata'],
    retention: 730,
    subProcessors: []
  },
  {
    id: 'transactional_email',
    label: 'Transactional email',
    basis: 'contract',
    dataCategories: ['email', 'display_name', 'locale'],
    // Provider retention: Resend retains delivery logs (recipient
    // address + send timestamp + status) for 30 days for
    // deliverability monitoring. The email body itself is sent
    // through-and-discarded: Resend doesn't archive content.
    retention: 30,
    subProcessors: ['resend']
  },
  // No `product_analytics` / `session_replay` purposes: no such script is
  // loaded, so listing them would be a false disclosure.
  {
    // Paid-plans waitlist (hosted SaaS while billing is off). Opt-in via
    // an unticked checkbox + double opt-in email. Retention: until the
    // person unsubscribes (one-click link in every email; deletes the
    // row), or at the latest 3 months after we send the launch
    // notification for paid plans. Unconfirmed sign-ups are deleted
    // after 7 days. Linked to the account (if signed in) and deleted
    // with it. No IP address is stored. See `waitlist_signups` in
    // server/db/schema/billing.ts.
    id: 'paid_plans_waitlist',
    label: 'Paid-plans waitlist',
    basis: 'consent',
    dataCategories: ['email', 'locale', 'consent_record', 'account_id_if_signed_in'],
    retention: 'until_withdrawn',
    subProcessors: ['ovh_postgres', 'resend']
  },
  {
    // Workspace invitations. A workspace admin types a collaborator's
    // email address; we keep it on a pending invitation (with the role
    // and who invited) until the person accepts or declines, an admin
    // revokes it, or it expires after 14 days (deleted by the
    // `workspace-invite-sweep`). If email is configured, one invitation
    // email per invite goes out via Resend (max 3 per address per day).
    // Nobody becomes a member without accepting. See `workspace_invites`
    // in server/db/schema/workspaces.ts.
    id: 'workspace_invitations',
    label: 'Workspace invitations',
    basis: 'legitimate_interest',
    dataCategories: ['invitee_email', 'workspace_role', 'inviter_id'],
    retention: 14,
    subProcessors: ['ovh_postgres', 'resend']
  },
  {
    // Abuse / illegal-content reports (DSA Art. 16-18 notice and action):
    // `abuse_reports` (what was reported and why: content URL + parsed doc
    // id, explanation, category; the reporter's name + email, required
    // unless CSAM, Art.16(2)(c): locale, good-faith confirmation time and
    // account if signed in; truncated IP + UA hash against report
    // flooding; the moderator's decision as sent) and `moderation_notices`
    // (the exact text of every receipt, decision notice and Art.17
    // statement of reasons, incl. ones recorded as undeliverable; FK
    // `ON DELETE CASCADE` on report_id, so they go with the report).
    // `abuse-report-sweep` deletes a report 1 year after it was closed
    // (actioned / dismissed, `actioned_at`; `NUXT_ABUSE_REPORT_RETENTION_DAYS`);
    // open reports stay until handled. Notices are emailed via Resend.
    // Anonymous reports are also covered by `anonymous_use_safeguards`
    // (bot check + rate limits).
    id: 'abuse_report_handling',
    label: 'Abuse and illegal-content reports',
    basis: 'legal_obligation',
    dataCategories: [
      'reported_content_url', 'report_explanation', 'report_category',
      'reporter_name', 'reporter_email', 'reporter_locale', 'good_faith_confirmation_time',
      'reporter_account_if_signed_in', 'ip_truncated', 'user_agent_hash',
      'moderation_decision', 'moderation_notices'
    ],
    retention: 365,
    subProcessors: ['ovh_postgres', 'resend']
  },
  {
    // Anonymous-use safeguards (server/utils/anonGate/). Before a document
    // is created without an account we record which Terms version the
    // visitor accepted and when (on the document row, so it is deleted
    // with the document: 30 days without activity), remember that
    // acceptance in a first-party httpOnly cookie (version + time, no
    // identifier), and run a proof-of-work bot check computed in our own
    // server (no third party, no cookie; the used challenge's signature is
    // kept in Valkey for ~20 minutes to stop replays). Per-network rate
    // limits (truncated to /64 for IPv6) count requests for at most a day.
    // The same bot check guards anonymous abuse reports.
    id: 'anonymous_use_safeguards',
    label: 'Terms acceptance and bot check for documents created without an account',
    basis: 'legitimate_interest',
    dataCategories: ['terms_version_accepted', 'acceptance_timestamp', 'bot_check_solution', 'rate_limit_counters'],
    retention: 30,
    subProcessors: ['ovh_postgres']
  },
  {
    id: 'error_monitoring',
    label: 'Error monitoring',
    basis: 'legitimate_interest',
    dataCategories: ['error_stack', 'request_url', 'user_id'],
    retention: 90,
    subProcessors: ['sentry']
  }
]
