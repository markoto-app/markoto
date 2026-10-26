// Audit-action constants for GDPR / DSA / AI-Act compliance events.
// `audit_log.action` is plain text in the schema (not pgEnum), so adding
// a new action is a TS-only change — no migration. Keep these grouped
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
// hash — leaking the hash to the audit log would weaken cache-eviction
// forensics. The token name is captured in `metadata.name` so the
// audit row is human-readable ("revoked 'Claude Desktop on laptop'").
export const AUDIT_MCP_TOKEN_ISSUED = 'mcp.token_issued'
export const AUDIT_MCP_TOKEN_REVOKED = 'mcp.token_revoked'

// Bring-your-own-key AI provider config saved / deleted (WP4). Storing a
// third-party API key and pointing the server at a base URL is a
// credential + outbound-traffic change, so it's audit-grade. `scope_id`
// is the user id; `metadata` carries capability, provider HOST and model
// — never the key (not even the last four characters).
export const AUDIT_AI_PROVIDER_SAVED = 'ai_provider.saved'
export const AUDIT_AI_PROVIDER_DELETED = 'ai_provider.deleted'

// Tagged union of every compliance audit action — useful for
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
    | typeof AUDIT_ADMIN_GRANTED
    | typeof AUDIT_ADMIN_REVOKED
    | typeof AUDIT_MCP_TOKEN_ISSUED
    | typeof AUDIT_MCP_TOKEN_REVOKED
    | typeof AUDIT_AI_PROVIDER_SAVED
    | typeof AUDIT_AI_PROVIDER_DELETED
