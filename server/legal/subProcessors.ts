// Single source of truth for our GDPR Article 28 sub-processor list.
// The /legal/sub-processors page renders this verbatim. Adding,
// removing, or relocating a sub-processor is a material privacy-policy
// change → bump `PRIVACY_VERSION` in shared/legal/versions.ts AND
// notify workspace-owner customers via email (≥30 days advance notice
// for B2B DPA compliance).

// Where the sub-processor's data plane is operationally located. NOT
// the legal seat of the parent company. e.g. AWS-Frankfurt-hosted
// Stripe ledger is `eu`; Stripe HQ in Ireland is irrelevant if the
// data plane is US.
export type DataLocation = 'eu' | 'us' | 'global'

// GDPR Article 44 transfer mechanism. `intra_eu` = no transfer; data
// stays in the EEA. `dpf` = EU-US Data Privacy Framework adequacy
// decision (July 2023, currently valid). `sccs` = Standard Contractual
// Clauses (fallback if DPF status changes).
export type TransferMechanism = 'intra_eu' | 'dpf' | 'sccs' | 'dpf_with_sccs_fallback'

export type SubProcessor = {
  // Stable id, referenced by lawfulBasis.ts and the i18n keys.
  id: string
  // Display name for the public sub-processor list.
  name: string
  // What we actually use them for. One short sentence.
  purpose: string
  location: DataLocation
  transferMechanism: TransferMechanism
  // Are they certified under the EU-US Data Privacy Framework? Only
  // relevant for `us` and `global` locations.
  dpfCertified: boolean
  // Public privacy policy URL.
  privacyPolicyUrl: string
  // Public DPA URL where available; null if we negotiated a custom
  // DPA out-of-band.
  dpaUrl: string | null
}

export const SUB_PROCESSORS: readonly SubProcessor[] = [
  {
    id: 'ovh_postgres',
    name: 'OVHcloud (Managed PostgreSQL)',
    purpose: 'Primary application database, Y.js document state, knowledge embeddings',
    location: 'eu',
    transferMechanism: 'intra_eu',
    dpfCertified: false,
    privacyPolicyUrl: 'https://www.ovhcloud.com/en/personal-data-protection/',
    dpaUrl: 'https://storage.gra.cloud.ovh.net/v1/AUTH_325716a587c64897acbef9a4a4726e38/contracts/9eb5c3d-DPA-9.0-2024-09-30.pdf'
  },
  {
    id: 'ovh_object_storage',
    name: 'OVHcloud (Object Storage)',
    purpose: 'Image uploads, knowledge-base originals (deleted post-processing), database backups',
    location: 'eu',
    transferMechanism: 'intra_eu',
    dpfCertified: false,
    privacyPolicyUrl: 'https://www.ovhcloud.com/en/personal-data-protection/',
    dpaUrl: 'https://storage.gra.cloud.ovh.net/v1/AUTH_325716a587c64897acbef9a4a4726e38/contracts/9eb5c3d-DPA-9.0-2024-09-30.pdf'
  },
  {
    id: 'mistral_ai',
    name: 'Mistral AI SAS',
    // Hosted: the free AI allowance runs on Z.ai GLM-5.3 Flash, served and
    // processed by Mistral itself through its EU endpoint
    // (api.eu.mistral.ai, deploy/config/litellm/config.yaml): Z.ai receives no
    // data, so it is not a sub-processor.
    // Every request goes to Mistral's EU regional endpoint (api.eu.mistral.ai):
    // the LiteLLM deployments and the live-dictation WebSocket.
    purpose: 'AI text generation for the writing assistant: the free AI allowance (Z.ai GLM-5.3 Flash, served and processed by Mistral; Z.ai receives no data) with Mistral Small as fallback; voice transcription (Voxtral). All requests go to Mistral\'s EU endpoint (data centres in the EU and EFTA)',
    location: 'eu',
    transferMechanism: 'intra_eu',
    dpfCertified: false,
    privacyPolicyUrl: 'https://legal.mistral.ai/terms/privacy-policy',
    dpaUrl: 'https://legal.mistral.ai/terms/data-processing-addendum'
  },
  {
    id: 'jina_ai',
    name: 'Jina AI GmbH',
    purpose: 'Embedding generation for knowledge-base RAG; single-URL page content extraction for the fetch-URL tool (Jina Reader; the URL is sent for every user, including users with their own AI provider)',
    location: 'eu',
    transferMechanism: 'intra_eu',
    dpfCertified: false,
    privacyPolicyUrl: 'https://jina.ai/legal/#privacy-policy',
    // Jina AI is part of Elastic; jina.ai/legal points to the
    // Elastic customer DPA for Jina products.
    dpaUrl: 'https://www.elastic.co/pdf/v100623-0-elastic-customer-dpa.pdf'
  },
  {
    id: 'staan',
    name: 'Staan (European Search Perspective SAS)',
    purpose: 'Web search for the AI writing assistant (the search query is sent for every user, including users with their own AI provider), via a proprietary European search index (EU-only routing)',
    location: 'eu',
    transferMechanism: 'intra_eu',
    dpfCertified: false,
    // The API privacy policy is /privacy-policy (/privacy is a 404).
    // Staan's DPA is available on request only.
    privacyPolicyUrl: 'https://staan.ai/privacy-policy',
    dpaUrl: null
  },
  {
    id: 'bfl',
    name: 'Black Forest Labs GmbH',
    purpose: 'Image generation via FLUX (EU-pinned data plane)',
    location: 'eu',
    transferMechanism: 'intra_eu',
    dpfCertified: false,
    privacyPolicyUrl: 'https://bfl.ai/privacy-policy/',
    // No public DPA URL exists; the DPA is concluded out of band.
    dpaUrl: null
  },
  {
    id: 'google_oauth',
    name: 'Google LLC (OAuth)',
    purpose: 'Sign-in via Google account (no other Google data accessed)',
    location: 'us',
    transferMechanism: 'dpf_with_sccs_fallback',
    dpfCertified: true,
    privacyPolicyUrl: 'https://policies.google.com/privacy',
    dpaUrl: null
  },
  {
    id: 'github_oauth',
    name: 'GitHub, Inc.',
    purpose: 'Sign-in via GitHub account (no other GitHub data accessed)',
    location: 'us',
    transferMechanism: 'dpf_with_sccs_fallback',
    dpfCertified: true,
    privacyPolicyUrl: 'https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement',
    dpaUrl: 'https://docs.github.com/en/site-policy/privacy-policies/github-data-protection-agreement'
  },
  {
    id: 'stripe',
    name: 'Stripe, Inc. (and Stripe Payments Europe Ltd.)',
    purpose: 'Subscription billing, payment method storage, invoice generation, fraud scoring',
    location: 'global',
    transferMechanism: 'dpf_with_sccs_fallback',
    dpfCertified: true,
    privacyPolicyUrl: 'https://stripe.com/privacy',
    dpaUrl: 'https://stripe.com/legal/dpa'
  },
  // Note: the Markitdown document-parsing service is deliberately NOT
  // listed here: we operate it ourselves on our own infrastructure
  // (Docker container co-located with the app). It is part of the
  // controller's own processing, not a third-party sub-processor.
  {
    id: 'sentry',
    name: 'Functional Software, Inc. (Sentry)',
    purpose: 'Application error + performance telemetry, stored in Sentry\'s EU (Frankfurt) data region',
    // Data at rest is the EU (Frankfurt) region, but the parent company is
    // US-based (support/operational access), so this is classified `global`
    // with DPF + SCC-fallback rather than `intra_eu`.
    location: 'global',
    transferMechanism: 'dpf_with_sccs_fallback',
    dpfCertified: true,
    privacyPolicyUrl: 'https://sentry.io/privacy/',
    dpaUrl: 'https://sentry.io/legal/dpa/'
  },
  {
    id: 'resend',
    name: 'Resend, Inc.',
    purpose: 'Transactional email delivery, account-deletion confirmations, data-export-ready notifications, breach notifications',
    location: 'global',
    transferMechanism: 'dpf_with_sccs_fallback',
    dpfCertified: true,
    privacyPolicyUrl: 'https://resend.com/legal/privacy-policy',
    dpaUrl: 'https://resend.com/legal/dpa'
  }
] as const
