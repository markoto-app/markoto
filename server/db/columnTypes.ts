// Shapes of the jsonb columns in `schema/` that only the server reads
// (`.$type<…>()` changes no SQL). Where a column's shape depends on another
// column of the row (a kind / action), the union is keyed by that column, and
// readers pair the two with the parsers here: rows written by older code are
// read back through zod, not trusted by a cast.
import { z } from 'zod'

// ── ai_session_messages.body ────────────────────────────────────────────

export type AiMessageKind = 'user_prompt' | 'tool_call' | 'message_to_user'

// The jsonb `body` per kind. Rows are read back from older data, so a field of
// the wrong type falls back to an empty value instead of dropping the row,
// and fields this code doesn't know are kept (the data export shows them).
const aiMessageEntry = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user_prompt'), body: z.looseObject({ text: z.string().catch('') }).catch({ text: '' }) }),
  z.object({ kind: z.literal('tool_call'), body: z.looseObject({ name: z.string().catch('<unknown>'), summary: z.string().catch('') }).catch({ name: '<unknown>', summary: '' }) }),
  z.object({ kind: z.literal('message_to_user'), body: z.looseObject({ message: z.string().catch(''), isQuestion: z.boolean().catch(false) }).catch({ message: '', isQuestion: false }) })
])

/** One memory row's kind with its body shape. */
export type AiMessageEntry = z.infer<typeof aiMessageEntry>
export type AiMessageBody = AiMessageEntry['body']

/** Pair a stored row's kind with its body, tolerating bodies written in an older shape. */
export function parseAiMessageEntry(kind: AiMessageKind, body: unknown): AiMessageEntry {
  return aiMessageEntry.parse({ kind, body })
}

// ── ai_jobs.params / estimate, ai_job_units.output ──────────────────────

/** What a delegated job does (written by the planner's tool, read by the job engine). */
export interface AiJobParams {
  instruction: string
  targetLanguage?: string | null
  /** ISO code of the source language when known (estimate ratio, language check). */
  sourceLanguage?: string | null
  glossary?: Array<{ source: string, target: string, note?: string }>
  style?: string | null
  /** The document's audience kind (`shared/audiences`). */
  audience?: string | null
  /** summarise: where the summary goes. */
  placement?: 'replace' | 'insert_at_start' | 'insert_at_end'
  granularity?: 'auto' | 'chapter' | 'section' | 'paragraph'
  /** Regex source: only paragraphs with a match become units. */
  onlyMatching?: string | null
  /** translate: pin old heading anchors as explicit ids (default true). */
  anchors?: boolean
  /** Approved preview outputs the workers imitate. */
  styleAnchors?: string[]
  /** translate: old → new heading texts. */
  headingMap?: Array<{ from: string, to: string }>
  /** Length band override (shorten jobs). */
  lengthBand?: { min: number, max: number } | null
}

export interface AiJobEstimate {
  units: number
  inputTokens: number
  outputTokens: number
  usd: number | null
  minutes: number
}

/** Result of a unit that is not applied as text: findings, scan items, or a preview. */
export type AiJobUnitOutput
  = | { kind: 'comments', findings: Array<{ quote: string, issue: string, suggestion?: string, severity: 'low' | 'medium' | 'high' }> }
    | { kind: 'scan', items: Array<{ text: string, example?: string }> }
    | { kind: 'preview', after: string, problems: string[] }

// ── audit_log.before / after / metadata ─────────────────────────────────
//
// One entry per action written today: `before` / `after` are the state the
// action changed (never secrets: passwords are `hasPassword`), `metadata` the
// context. `appendAuditEvent` takes the entry of its `action`, so a writer
// cannot drift from what the workspace audit viewer and the data export show.
// A key that is absent means the action does not record that part.

type AccessMode = 'open-edit' | 'open-view' | 'private' | 'password-protected'
/** A document's sharing state, recorded when it is deleted. */
export type AuditDocSnapshot = { title: string, accessMode: AccessMode, ownerId: number | null, workspaceId: string | null }
type AbuseStatus = { status: string, notes: string | null }
type AbuseDecisionMetadata = {
  reportId: string
  category: string
  docId: string | null
  decisionAction?: string
  decisionRule?: string
  contentEffect?: string
  reporterNotice?: string
  ownerNotice?: string
}
type ModerationReason = { reason: 'moderation', reportId: string }
type BrandAsset = { kind: 'font', family: string, weight: number | null, style: string | null, format?: string } | { kind: 'image', name: string, format?: string }
type SsoProtocol = 'oidc' | 'saml'
type MemberAiLimit = { aiLimitUsd: number | null, aiUnlimited: boolean }

export interface AuditEventShapes {
  'account.delete_requested': { after: { deletionRequestedAt: string | null, deletionGraceUntil: string | null, graceDays: number } }
  'account.delete_cancelled': { before: { deletionRequestedAt: string | null, deletionGraceUntil: string | null } | null }
  'account.delete_executed': { metadata: { summary: Record<string, number | boolean>, stripeCustomerId: string | null } }
  'account.export_requested': { metadata: { jobId: string } }
  'account.export_completed': { after: { jobId: string, s3Key: string, sizeBytes: number, counts: Record<string, number> } }
  'account.export_failed': { metadata: { jobId: string, errorMessage: string } }
  'account.age_confirmed': { metadata: { locale: string } }
  'account.sessions_revoked': object
  'consent.recorded': { metadata: { purposes: string[] } }
  'policy.accepted': { metadata: { document: 'privacy' | 'tos' | 'dpa' | 'paid-terms', version: number, locale?: string, purchase?: string, item?: string } }
  'abuse.reported': { metadata: { reportId: string, category: string, docId: string | null, anonymous: boolean } }
  'abuse.acknowledged': { before: AbuseStatus, after: AbuseStatus, metadata: AbuseDecisionMetadata }
  'abuse.actioned': { before: AbuseStatus, after: AbuseStatus, metadata: AbuseDecisionMetadata }
  'abuse.dismissed': { before: AbuseStatus, after: AbuseStatus, metadata: AbuseDecisionMetadata }
  'abuse.notice_recorded': { metadata: { reportId: string, kind: string, recipientRole: 'reporter' | 'owner', status: string } }
  'admin.granted': { after: { isAdmin: true }, metadata: { via: 'env-allowlist', email: string | null } }
  'admin.revoked': { after: { isAdmin: false } }
  'mcp.token_issued': { metadata: { tokenId: string, name: string, scopes: string[] } }
  'mcp.token_revoked': { metadata: { tokenId: string, name: string } }
  'ai_provider.saved': { metadata: { capability: string, host: string | null, model: string } }
  'ai_provider.deleted': { metadata: { capability: string } }
  'doc.deleted': {
    before: AuditDocSnapshot | null
    metadata: { reason: 'user_initiated' | 'inactive_sweep' | 'bulk' } | { reason: 'workspace_cascade', workspaceId: string } | { reason: 'folder_deleted', folderId: string } | ModerationReason
  }
  'doc.folder_moved': { before: { folderId: string | null }, after: { folderId: string | null } }
  'folder.created': { metadata: { folderId: string, name: string, parentId: string | null } }
  'folder.renamed': { before: { name: string }, after: { name: string }, metadata: { folderId: string } }
  'folder.moved': { before: { parentId: string | null }, after: { parentId: string | null }, metadata: { folderId: string } }
  'folder.deleted': { before: { name: string, parentId: string | null }, metadata: { folderId: string, folders: number, documents: number } }
  'import.completed': { metadata: { jobId: string, source: string, status: string, total: number, done: number, failed: number, skipped: number } }
  'doc.workspace_moved': { before: { workspaceId: string | null }, after: { workspaceId: string | null }, metadata?: { templatesRemoved?: number, guestSharesRemoved?: number } }
  'doc.password_set': { before: { accessMode: AccessMode, hasPassword: boolean }, after: { accessMode: 'password-protected', hasPassword: true } }
  'doc.password_removed': { before: { accessMode: AccessMode, hasPassword: boolean }, after: { accessMode: 'open-edit', hasPassword: false } }
  'doc.access_mode_changed': {
    before: { accessMode: string | null }
    after: { accessMode: AccessMode, moderationRestricted?: true }
    metadata?: ModerationReason & { guestSharesRemoved?: number }
  }
  'doc.moderation_restriction_lifted': { before: { restrictedAt: string }, metadata: { reportId: string, note: string | null } }
  'doc.shared': { before: { access: 'view' | 'edit' } | null, after: { access: 'view' | 'edit' }, metadata: { affectedUserId: number } }
  'doc.unshared': { metadata: { affectedUserId: number } }
  'doc.share_settings_changed': { before: { expiresAt: string | null, noDownload: boolean }, after: { expiresAt: string | null, noDownload: boolean } }
  'doc.published': { metadata: { pageId: string, slug: string, republish: boolean, indexable: boolean } }
  'doc.unpublished': { metadata: { pageId: string } | ModerationReason & { pageId: string } }
  'doc.publish_settings_changed': { before: { slug: string, indexable: boolean }, after: { slug: string, indexable: boolean } }
  'workspace.deleted': { metadata: { deletedDocs: number, deletedKnowledge: number } }
  'workspace.member_removed': { before: { role: string | null }, metadata: { affectedUserId: number, workspaceId: string, isSelf: boolean } }
  'workspace.member_role_changed': { before: { role: string }, after: { role: string }, metadata: { affectedUserId: number, workspaceId: string } }
  'workspace.invite_created': { metadata: { inviteId: string, role: string, emailed: boolean } }
  'workspace.invite_revoked': { metadata: { inviteId: string, role: string } }
  'workspace.invite_accepted': { after: { role: string }, metadata: { inviteId: string, via: string, alreadyMember: boolean } }
  'workspace.invite_declined': { metadata: { inviteId: string, via: string } }
  'workspace.billing_checkout_started': { metadata: { plan: string, seats: number, interval: string, currency: string } }
  'workspace.billing_plan_changed': { before: { plan: string, interval: string } | null, after: { plan: string, interval: string } }
  'workspace.billing_seats_changed': { before: { seats: number }, after: { seats: number }, metadata?: { reason: 'invite' } }
  'workspace.billing_admin_changed': { before: { billingAdminId: number }, after: { billingAdminId: number | null }, metadata: { reason: 'account_deleted', cancelledAtPeriodEnd: boolean } }
  'workspace.member_ai_limit_changed': { after: MemberAiLimit, metadata: { affectedUserId: number } }
  'workspace.subscription_cancelled': { before: { plan: string, seats: number, status: string }, metadata: { reason: 'workspace_deleted' } }
  'workspace.billing_plan_resumed': { before: { cancelAt: string | null }, metadata: { plan: string, seats: number } }
  'billing.plan_resumed': { before: { cancelAt: string | null }, metadata: { plan: string } }
  'workspace.audit_exported': { metadata: { format: string, rows: number, from: string | null, to: string | null } }
  'workspace.brand_asset_added': { after: BrandAsset, metadata: { assetId: string, sizeBytes: number } }
  'workspace.brand_asset_removed': { before: BrandAsset, metadata: { assetId: string } }
  'workspace.brand_lock_changed': { before: { locked: boolean }, after: { locked: boolean }, metadata: { documents: number } }
  'workspace.template_added': { after: { name: string }, metadata: { templateId: string, docId: string } }
  'workspace.template_removed': { metadata: { templateId: string, docId: string } }
  'design_import.started': { metadata: { format: string, sizeBytes: number } }
  'sso.connection_saved': { metadata: { protocol: SsoProtocol, created: boolean, idpChanged: boolean, status: string } }
  'sso.connection_activated': { metadata: { protocol: SsoProtocol } }
  'sso.connection_deleted': { metadata: Record<string, never> }
  'sso.domain_added': { metadata: { domain: string } }
  'sso.domain_verified': { metadata: { domain: string } }
  'sso.domain_removed': { metadata: { domain: string } }
  'sso.sign_in': { metadata: { protocol: SsoProtocol, outcome: 'ok' | 'refused' | 'rejected', code?: string, test?: boolean, created?: boolean } }
  'sso.identity_linked': { metadata: { protocol: SsoProtocol } }
  'sso.member_joined': { metadata: { role: string, via: 'sign_in' } }
  'sso.scim_token_rotated': { metadata: { revoked: boolean } }
  'sso.scim_user_created': { metadata: { affectedUserId: number, accountCreated: boolean, active: boolean } }
  'sso.scim_user_deactivated': { metadata: { affectedUserId: number, deleted?: true } }
  'custom_domain.added': { metadata: { domainId: string, hostname: string } }
  'custom_domain.verified': { metadata: { domainId: string, hostname: string, problem?: string } }
  'custom_domain.dropped': { metadata: { domainId: string, hostname: string, problem?: string } }
  'custom_domain.removed': { metadata: { domainId: string, hostname: string } }
  'ai.job.started': { metadata: { jobId: string, mode: string, units: number, resumed: boolean } }
  'ai.job.reverted': { metadata: { jobId: string, mode: string, reverted: number, skipped: number } }
}

export type AuditAction = keyof AuditEventShapes

type AuditPart = 'before' | 'after' | 'metadata'
type AuditShape<A extends AuditAction> = AuditEventShapes[A]

/**
 * The `before` / `after` / `metadata` an audit event of action `A` records.
 * Each part may be left out (stored as null), but a part that is given has
 * the action's shape; a part the action does not record may only be `null`.
 */
export type AuditEventParts<A extends AuditAction> = Partial<AuditShape<A>> & {
  [K in Exclude<AuditPart, keyof AuditShape<A>>]?: null
}

type AnyPart<K extends AuditPart> = {
  [A in AuditAction]: K extends keyof AuditShape<A> ? NonNullable<AuditShape<A>[K]> : never
}[AuditAction]
export type AuditBefore = AnyPart<'before'>
export type AuditAfter = AnyPart<'after'>
export type AuditMetadata = AnyPart<'metadata'>
