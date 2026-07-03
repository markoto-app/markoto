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
  // Lawful basis under GDPR Article 6.
  basis: LawfulBasis
  // Categories of personal data touched. Free-form short labels;
  // referenced by the privacy policy page.
  dataCategories: string[]
  // Retention in days from last activity, or 'until_deletion' for
  // account-bound data, or 'legal_minimum' for billing/tax.
  retention: number | 'until_deletion' | 'legal_minimum'
  // Sub-processor ids (from server/legal/subProcessors.ts) that touch
  // this purpose's data. Empty array = handled in-house only.
  subProcessors: string[]
}

export const PROCESSING_PURPOSES: readonly ProcessingPurpose[] = [
  {
    id: 'account_authentication',
    basis: 'contract',
    dataCategories: ['email', 'oauth_identifier', 'display_name', 'avatar_url'],
    retention: 'until_deletion',
    subProcessors: ['github_oauth', 'google_oauth']
  },
  {
    id: 'document_storage',
    basis: 'contract',
    dataCategories: ['document_content', 'document_metadata', 'images'],
    retention: 'until_deletion',
    subProcessors: ['ovh_postgres', 'ovh_object_storage']
  },
  {
    id: 'collaboration_sync',
    basis: 'contract',
    dataCategories: ['document_content', 'cursor_positions', 'awareness_state'],
    retention: 'until_deletion',
    subProcessors: ['ovh_postgres']
  },
  {
    id: 'comments_and_mentions',
    basis: 'contract',
    dataCategories: ['comment_body', 'author_name', 'mention_targets'],
    retention: 'until_deletion',
    subProcessors: ['ovh_postgres']
  },
  {
    id: 'ai_assistance',
    basis: 'contract',
    dataCategories: ['user_prompt', 'document_context', 'ai_generated_content'],
    retention: 90,
    subProcessors: ['mistral_ai', 'jina_ai', 'bfl', 'staan']
  },
  {
    id: 'workspace_knowledge_rag',
    basis: 'contract',
    dataCategories: ['uploaded_files', 'extracted_text', 'embeddings'],
    retention: 'until_deletion',
    subProcessors: ['jina_ai', 'ovh_postgres', 'ovh_object_storage']
  },
  {
    id: 'billing',
    basis: 'contract',
    dataCategories: ['stripe_customer_id', 'subscription_state', 'invoice_history'],
    retention: 'legal_minimum',
    subProcessors: ['stripe']
  },
  {
    id: 'fraud_and_abuse_prevention',
    basis: 'legitimate_interest',
    dataCategories: ['ip_truncated', 'user_agent_hash', 'rate_limit_counters'],
    retention: 90,
    subProcessors: []
  },
  {
    id: 'security_audit_log',
    basis: 'legal_obligation',
    dataCategories: ['actor_id', 'ip_truncated', 'action_metadata'],
    retention: 'legal_minimum',
    subProcessors: []
  },
  {
    id: 'transactional_email',
    basis: 'contract',
    dataCategories: ['email', 'display_name', 'locale'],
    // Provider retention: Resend retains delivery logs (recipient
    // address + send timestamp + status) for 30 days for
    // deliverability monitoring. The email body itself is sent
    // through-and-discarded — Resend doesn't archive content.
    retention: 30,
    subProcessors: ['resend']
  },
  {
    id: 'product_analytics',
    basis: 'consent',
    dataCategories: ['page_views', 'feature_usage', 'pseudonymous_id'],
    retention: 365,
    subProcessors: []
  },
  {
    id: 'session_replay',
    basis: 'consent',
    dataCategories: ['ui_interaction_recording', 'pseudonymous_id'],
    retention: 30,
    subProcessors: []
  },
  {
    id: 'error_monitoring',
    basis: 'legitimate_interest',
    dataCategories: ['error_stack', 'request_url', 'user_id'],
    retention: 90,
    subProcessors: ['sentry']
  }
]

export function getProcessingPurpose(id: string): ProcessingPurpose | undefined {
  return PROCESSING_PURPOSES.find(p => p.id === id)
}
