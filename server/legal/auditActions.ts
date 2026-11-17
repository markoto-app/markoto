// Audit-action constants for GDPR / DSA / AI-Act compliance events.
// `audit_log.action` is plain text in the schema (not pgEnum), so adding
// a new action is a TS-only change, no migration. Keep these grouped
// here so the compliance surface has a single audit-action vocabulary.
//
// All actions are lowercase, dot-separated, namespace-first. Match the
// existing convention used elsewhere in the audit log (`doc.deleted`,
// `workspace.member_removed`, etc.).

// Account lifecycle
export const AUDIT_ACCOUNT_DELETE_REQUESTED = 'account.delete_requested'
export const AUDIT_ACCOUNT_DELETE_CANCELLED = 'account.delete_cancelled'
export const AUDIT_ACCOUNT_DELETE_EXECUTED = 'account.delete_executed'
export const AUDIT_ACCOUNT_EXPORT_REQUESTED = 'account.export_requested'
export const AUDIT_ACCOUNT_EXPORT_COMPLETED = 'account.export_completed'
export const AUDIT_ACCOUNT_EXPORT_FAILED = 'account.export_failed'
export const AUDIT_ACCOUNT_AGE_CONFIRMED = 'account.age_confirmed'

// Consent + policy acceptance
export const AUDIT_CONSENT_RECORDED = 'consent.recorded'
export const AUDIT_POLICY_ACCEPTED = 'policy.accepted'

// Abuse pipeline
export const AUDIT_ABUSE_REPORTED = 'abuse.reported'
export const AUDIT_ABUSE_ACKNOWLEDGED = 'abuse.acknowledged'
export const AUDIT_ABUSE_ACTIONED = 'abuse.actioned'
export const AUDIT_ABUSE_DISMISSED = 'abuse.dismissed'
// A DSA notice the pipeline produced for a report, confirmation of
// receipt (Art.16(4)), decision to the reporter (Art.16(5)) or statement
// of reasons to the owner (Art.17), sent or recorded as not deliverable.
// `scope_id` = report id; metadata: kind, recipient role, status. The text
// itself lives in `moderation_notices`, never in the audit row.
export const AUDIT_ABUSE_NOTICE_RECORDED = 'abuse.notice_recorded'
// A platform admin lifted a document's moderation restriction (set by an
// `access_restricted` decision, which itself is audited as
// `doc.access_mode_changed` with reason `moderation`). `scope` doc,
// `scope_id` the document id; metadata: the report the restriction came
// from and the admin's note.
export const AUDIT_DOC_MODERATION_RESTRICTION_LIFTED = 'doc.moderation_restriction_lifted'

// Platform-admin grants. Granted via the env allowlist bootstrap
// or (forthcoming) via an admin-management UI; revoked the same way.
// Both audit rows carry actor (the granting admin or `null` for
// the env-bootstrap path) + scope_id (the target user id).
export const AUDIT_ADMIN_GRANTED = 'admin.granted'
export const AUDIT_ADMIN_REVOKED = 'admin.revoked'

// MCP Personal Access Token lifecycle. Issuing or revoking a PAT is
// equivalent to handing out (or rescinding) full-account API access,
// so it's an audit-grade event. `actor` is always the user themselves
// (PATs are issued + revoked from the user's own session); the
// `scope_id` is the public token id (`mkt_pat_…`), NOT the SHA-256
// hash: leaking the hash to the audit log would weaken cache-eviction
// forensics. The token name is captured in `metadata.name` so the
// audit row is human-readable ("revoked 'Claude Desktop on laptop'").
export const AUDIT_MCP_TOKEN_ISSUED = 'mcp.token_issued'
export const AUDIT_MCP_TOKEN_REVOKED = 'mcp.token_revoked'

// Bring-your-own-key AI provider config saved / deleted. Storing a
// third-party API key and pointing the server at a base URL is a
// credential + outbound-traffic change, so it's audit-grade. `scope_id`
// is the user id; `metadata` carries capability, provider HOST and model
// never the key (not even the last four characters).
export const AUDIT_AI_PROVIDER_SAVED = 'ai_provider.saved'
export const AUDIT_AI_PROVIDER_DELETED = 'ai_provider.deleted'

// "Log out everywhere": the user's session epoch was bumped, every
// outstanding session cookie stopped working. `scope_id` is the user id.
export const AUDIT_ACCOUNT_SESSIONS_REVOKED = 'account.sessions_revoked'

// Workspace invitations (pending invite + accept). `scope` is
// `workspace`, `scope_id` the workspace id. The invitee's email is NOT
// copied into the audit row (it lives on the invite row, which is
// deleted on accept / decline / revoke / expiry); `metadata` carries the
// invite id + role only.
export const AUDIT_WORKSPACE_INVITE_CREATED = 'workspace.invite_created'
export const AUDIT_WORKSPACE_INVITE_REVOKED = 'workspace.invite_revoked'
export const AUDIT_WORKSPACE_INVITE_ACCEPTED = 'workspace.invite_accepted'
export const AUDIT_WORKSPACE_INVITE_DECLINED = 'workspace.invite_declined'

// Team / Business workspace billing. `scope` is `billing`,
// `scope_id` the workspace id. Metadata: plan / seats / interval /
// currency, the affected member id for limits, never card data (Stripe
// holds that).
export const AUDIT_WORKSPACE_BILLING_CHECKOUT_STARTED = 'workspace.billing_checkout_started'
export const AUDIT_WORKSPACE_BILLING_PLAN_CHANGED = 'workspace.billing_plan_changed'
export const AUDIT_WORKSPACE_BILLING_SEATS_CHANGED = 'workspace.billing_seats_changed'
export const AUDIT_WORKSPACE_BILLING_ADMIN_CHANGED = 'workspace.billing_admin_changed'
export const AUDIT_WORKSPACE_MEMBER_AI_LIMIT_CHANGED = 'workspace.member_ai_limit_changed'
export const AUDIT_WORKSPACE_SUBSCRIPTION_CANCELLED = 'workspace.subscription_cancelled'
// An admin took back the cancellation of a plan that still runs.
export const AUDIT_WORKSPACE_BILLING_PLAN_RESUMED = 'workspace.billing_plan_resumed'

// The user took back the cancellation of their own Pro plan. `scope`
// user, `scope_id` the user id.
export const AUDIT_BILLING_PLAN_RESUMED = 'billing.plan_resumed'

// Tax compliance (Stripe Tax on), operator alerts only (never in a
// workspace's own audit log). `scope` user / billing, `scope_id` the user or
// workspace id (null once unknown). Metadata: Stripe ids and country codes,
// never an IP address or card data.
// The location evidence of a consumer sale disagrees with the billing country.
export const AUDIT_BILLING_TAX_EVIDENCE_CONTRADICTION = 'billing.tax_evidence_contradiction'
// A sale from a region we may not sell to was cancelled and refunded.
export const AUDIT_BILLING_SALE_REFUSED = 'billing.sale_refused'
// A customer's VAT / tax ID failed the government check (and was removed).
export const AUDIT_BILLING_TAX_ID_UNVERIFIED = 'billing.tax_id_unverified'
// A running subscription now bills a region we may not sell to: manual follow-up.
export const AUDIT_BILLING_SALE_REGION_REVIEW = 'billing.sale_region_review'

// "Create a design from a document" started: an uploaded PDF / Word file
// went to the sandboxed extractor and its design facts to the user's AI
// provider. `scope` user, `scope_id` the user id; metadata: format and
// size only (never the file name or content).
export const AUDIT_DESIGN_IMPORT_STARTED = 'design_import.started'

// Per-workspace single sign-on. `scope` workspace, `scope_id` the
// workspace id. Metadata: protocol, domain, the affected user id, never
// a client secret, certificate body, SCIM token or assertion.
export const AUDIT_SSO_CONNECTION_SAVED = 'sso.connection_saved'
export const AUDIT_SSO_CONNECTION_ACTIVATED = 'sso.connection_activated'
export const AUDIT_SSO_CONNECTION_DELETED = 'sso.connection_deleted'
export const AUDIT_SSO_DOMAIN_ADDED = 'sso.domain_added'
export const AUDIT_SSO_DOMAIN_VERIFIED = 'sso.domain_verified'
export const AUDIT_SSO_DOMAIN_REMOVED = 'sso.domain_removed'
export const AUDIT_SSO_SIGN_IN = 'sso.sign_in'
export const AUDIT_SSO_IDENTITY_LINKED = 'sso.identity_linked'
export const AUDIT_SSO_MEMBER_JOINED = 'sso.member_joined'
export const AUDIT_SSO_SCIM_TOKEN_ROTATED = 'sso.scim_token_rotated'
export const AUDIT_SSO_SCIM_USER_CREATED = 'sso.scim_user_created'
export const AUDIT_SSO_SCIM_USER_DEACTIVATED = 'sso.scim_user_deactivated'

// Workspace audit log: an admin downloaded it. Metadata: format,
// row count, date range.
export const AUDIT_WORKSPACE_AUDIT_EXPORTED = 'workspace.audit_exported'

// A workspace document shared with a guest / no longer. Metadata:
// the guest's user id; before / after: the access (view / edit).
export const AUDIT_DOC_SHARED = 'doc.shared'
export const AUDIT_DOC_UNSHARED = 'doc.unshared'

// Share-link controls changed. Before / after: expiresAt, noDownload.
export const AUDIT_DOC_SHARE_SETTINGS_CHANGED = 'doc.share_settings_changed'

// Workspace brand kit. Metadata: asset id, kind, name (font family
// or file name), weight/style; lock: before/after; templates: template id
// + document id.
export const AUDIT_WORKSPACE_BRAND_ASSET_ADDED = 'workspace.brand_asset_added'
export const AUDIT_WORKSPACE_BRAND_ASSET_REMOVED = 'workspace.brand_asset_removed'
export const AUDIT_WORKSPACE_BRAND_LOCK_CHANGED = 'workspace.brand_lock_changed'
export const AUDIT_WORKSPACE_TEMPLATE_ADDED = 'workspace.template_added'
export const AUDIT_WORKSPACE_TEMPLATE_REMOVED = 'workspace.template_removed'

// Publish as a web page + custom domains. Published / unpublished:
// metadata page id + slug; settings: before / after {slug, indexable};
// custom domains: metadata hostname (+ page id).
export const AUDIT_DOC_PUBLISHED = 'doc.published'
export const AUDIT_DOC_UNPUBLISHED = 'doc.unpublished'
export const AUDIT_DOC_PUBLISH_SETTINGS_CHANGED = 'doc.publish_settings_changed'
export const AUDIT_CUSTOM_DOMAIN_ADDED = 'custom_domain.added'
export const AUDIT_CUSTOM_DOMAIN_VERIFIED = 'custom_domain.verified'
export const AUDIT_CUSTOM_DOMAIN_REMOVED = 'custom_domain.removed'
// A live domain whose DNS stayed wrong past the grace period stops (system).
export const AUDIT_CUSTOM_DOMAIN_DROPPED = 'custom_domain.dropped'

// Tagged union of every compliance audit action, useful for
// exhaustiveness checks at call sites.
export type ComplianceAuditAction
  = | typeof AUDIT_ACCOUNT_DELETE_REQUESTED
    | typeof AUDIT_ACCOUNT_DELETE_CANCELLED
    | typeof AUDIT_ACCOUNT_DELETE_EXECUTED
    | typeof AUDIT_ACCOUNT_EXPORT_REQUESTED
    | typeof AUDIT_ACCOUNT_EXPORT_COMPLETED
    | typeof AUDIT_ACCOUNT_EXPORT_FAILED
    | typeof AUDIT_ACCOUNT_AGE_CONFIRMED
    | typeof AUDIT_CONSENT_RECORDED
    | typeof AUDIT_POLICY_ACCEPTED
    | typeof AUDIT_ABUSE_REPORTED
    | typeof AUDIT_ABUSE_ACKNOWLEDGED
    | typeof AUDIT_ABUSE_ACTIONED
    | typeof AUDIT_ABUSE_DISMISSED
    | typeof AUDIT_ABUSE_NOTICE_RECORDED
    | typeof AUDIT_DOC_MODERATION_RESTRICTION_LIFTED
    | typeof AUDIT_ADMIN_GRANTED
    | typeof AUDIT_ADMIN_REVOKED
    | typeof AUDIT_MCP_TOKEN_ISSUED
    | typeof AUDIT_MCP_TOKEN_REVOKED
    | typeof AUDIT_AI_PROVIDER_SAVED
    | typeof AUDIT_AI_PROVIDER_DELETED
    | typeof AUDIT_ACCOUNT_SESSIONS_REVOKED
    | typeof AUDIT_WORKSPACE_INVITE_CREATED
    | typeof AUDIT_WORKSPACE_INVITE_REVOKED
    | typeof AUDIT_WORKSPACE_INVITE_ACCEPTED
    | typeof AUDIT_WORKSPACE_INVITE_DECLINED
    | typeof AUDIT_WORKSPACE_BILLING_CHECKOUT_STARTED
    | typeof AUDIT_WORKSPACE_BILLING_PLAN_CHANGED
    | typeof AUDIT_WORKSPACE_BILLING_SEATS_CHANGED
    | typeof AUDIT_WORKSPACE_BILLING_ADMIN_CHANGED
    | typeof AUDIT_WORKSPACE_MEMBER_AI_LIMIT_CHANGED
    | typeof AUDIT_WORKSPACE_SUBSCRIPTION_CANCELLED
    | typeof AUDIT_WORKSPACE_BILLING_PLAN_RESUMED
    | typeof AUDIT_BILLING_PLAN_RESUMED
    | typeof AUDIT_BILLING_TAX_EVIDENCE_CONTRADICTION
    | typeof AUDIT_BILLING_SALE_REFUSED
    | typeof AUDIT_BILLING_TAX_ID_UNVERIFIED
    | typeof AUDIT_BILLING_SALE_REGION_REVIEW
    | typeof AUDIT_DESIGN_IMPORT_STARTED
    | typeof AUDIT_SSO_CONNECTION_SAVED
    | typeof AUDIT_SSO_CONNECTION_ACTIVATED
    | typeof AUDIT_SSO_CONNECTION_DELETED
    | typeof AUDIT_SSO_DOMAIN_ADDED
    | typeof AUDIT_SSO_DOMAIN_VERIFIED
    | typeof AUDIT_SSO_DOMAIN_REMOVED
    | typeof AUDIT_SSO_SIGN_IN
    | typeof AUDIT_SSO_IDENTITY_LINKED
    | typeof AUDIT_SSO_MEMBER_JOINED
    | typeof AUDIT_SSO_SCIM_TOKEN_ROTATED
    | typeof AUDIT_SSO_SCIM_USER_CREATED
    | typeof AUDIT_SSO_SCIM_USER_DEACTIVATED
    | typeof AUDIT_WORKSPACE_AUDIT_EXPORTED
    | typeof AUDIT_DOC_SHARED
    | typeof AUDIT_DOC_UNSHARED
    | typeof AUDIT_DOC_SHARE_SETTINGS_CHANGED
    | typeof AUDIT_WORKSPACE_BRAND_ASSET_ADDED
    | typeof AUDIT_WORKSPACE_BRAND_ASSET_REMOVED
    | typeof AUDIT_WORKSPACE_BRAND_LOCK_CHANGED
    | typeof AUDIT_WORKSPACE_TEMPLATE_ADDED
    | typeof AUDIT_WORKSPACE_TEMPLATE_REMOVED
    | typeof AUDIT_DOC_PUBLISHED
    | typeof AUDIT_DOC_UNPUBLISHED
    | typeof AUDIT_DOC_PUBLISH_SETTINGS_CHANGED
    | typeof AUDIT_CUSTOM_DOMAIN_ADDED
    | typeof AUDIT_CUSTOM_DOMAIN_VERIFIED
    | typeof AUDIT_CUSTOM_DOMAIN_REMOVED
    | typeof AUDIT_CUSTOM_DOMAIN_DROPPED
