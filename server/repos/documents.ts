import { and, eq, or, sql } from 'drizzle-orm'
import type { DocTheme } from '~~/shared/types/theme'
import type { AudienceKind } from '~~/shared/audiences'
import { documentShares, documents, workspaceMembers } from '../db/schema'
import { ssoEnforcedSql, ssoSatisfiedSql } from './sso'
import type { WorkspaceRole } from '../../shared/utils/documents/docPermissions'
import { useDatabase } from '../utils/platform/database'
import { NotFoundError } from './errors'

// Documents repository: every read/write of the `documents` table goes through
// here, so endpoints work with domain shapes (`DocSnapshot`, `DocAuthzRow`)
// instead of Drizzle rows, and the "doc + joined workspace role" fetch lives
// once in `getDocWithActorRole`. `createDocumentsRepo(db)` takes an explicit
// Drizzle instance for unit tests; the default export uses `useDatabase()`.

export type AccessMode = 'private' | 'open-edit' | 'open-view' | 'password-protected'

export interface DocSnapshot {
  docId: string
  ownerId: number | null
  workspaceId: string | null
  accessMode: AccessMode
  title: string
  passwordHash: string | null
  theme: DocTheme | null
  wordCount: number | null
  sizeBytes: number | null
  /** One-line "what this doc is about" — empty string means not set. */
  description: string
  /** Closed enum of writing registers. Drives AI tone via `shared/audiences`. */
  audience: AudienceKind
  /** Free-form language string (ISO code or user-typed name). Drives AI output language. */
  language: string
  /** Provenance of the structural skeleton picked at creation time. */
  templateId: string
  /** Restricted by a moderation decision: may not be shared or published (null = not restricted). */
  moderationRestrictedAt: Date | null
  moderationReportId: string | null
  createdAt: Date
  lastActive: Date
}

export interface DocAuthzRow {
  ownerId: number | null
  workspaceId: string | null
  accessMode: AccessMode
  /** Anonymous docs: hash of the creating browser's key (never sent to clients). */
  anonCreatorKeyHash: string | null
  theme: DocTheme | null
  workspaceRole: WorkspaceRole | null
  /**
   * The caller is a GUEST of the document's workspace:
   * `workspaceRole` then comes from their share of this document only.
   */
  isGuest: boolean
  /**
   * True when the caller OWNS the doc but that ownership must not count:
   * the doc sits in a workspace that enforces single sign-on and
   * the caller has no effective role there (no current SSO grant, or no
   * longer a member — e.g. deactivated / deleted via SCIM). Ownership of
   * a workspace doc then grants nothing beyond what any outsider gets.
   * Always false in workspaces without an active SSO connection and for
   * standalone docs (unchanged behaviour). Feed the row to the decide*
   * functions through `docStateOf` / `isEffectiveDocOwner`
   * (`shared/utils/documents/docPermissions.ts`) so the rule applies everywhere.
   */
  ownerAccessSuspended: boolean
  /** Share-link controls: when public access ends (null = never). `docStateOf` applies it. */
  shareExpiresAt: Date | null
  /** Share-link controls: no PDF / Markdown download or print for visitors. */
  shareNoDownload: boolean
  /**
   * Document context fields, surfaced through the token endpoint so the editor
   * can hydrate the Document tab before Y.js sync completes. The documents row
   * is the source of truth; ymeta.* mirrors carry live updates.
   */
  title: string
  description: string
  audience: AudienceKind
  language: string
  templateId: string
}

export interface CreateDocInput {
  docId: string
  ownerId: number | null
  workspaceId: string | null
  accessMode: AccessMode
  /**
   * Optional context fields from the new-doc dialog; each falls back to the
   * schema default when omitted.
   */
  title?: string
  description?: string
  audience?: AudienceKind
  language?: string
  templateId?: string
  theme?: DocTheme | null
  /** Anonymous docs only: SHA-256 of the creating browser's creator key. */
  anonCreatorKeyHash?: string
  /** Anonymous docs only: the Terms version + acceptance time from the gate. */
  anonTermsVersion?: number
  anonTermsAcceptedAt?: Date
}

export interface MetaUpdate {
  title?: string
  accessMode?: AccessMode
  wordCount?: number
  sizeBytes?: number
  theme?: DocTheme | null
  description?: string
  audience?: AudienceKind
  language?: string
  /** Which template the document started from (Markdown import restores it). */
  templateId?: string
}

/** Fetch the full document row; null (not a throw) when missing so handlers choose their own 404. */
export async function getDoc(docId: string): Promise<DocSnapshot | null> {
  const db = useDatabase()
  const row = (await db
    .select()
    .from(documents)
    .where(eq(documents.docId, docId))
    .limit(1))[0]
  if (!row) return null
  return {
    docId: row.docId,
    ownerId: row.ownerId,
    workspaceId: row.workspaceId,
    accessMode: row.accessMode,
    title: row.title,
    passwordHash: row.passwordHash,
    theme: row.theme,
    wordCount: row.wordCount,
    sizeBytes: row.sizeBytes,
    description: row.description,
    audience: row.audience,
    language: row.language,
    templateId: row.templateId,
    moderationRestrictedAt: row.moderationRestrictedAt,
    moderationReportId: row.moderationReportId,
    createdAt: row.createdAt,
    lastActive: row.lastActive
  }
}

/** Existence check without loading the row. */
export async function docExists(docId: string): Promise<boolean> {
  const db = useDatabase()
  const row = (await db
    .select({ docId: documents.docId })
    .from(documents)
    .where(eq(documents.docId, docId))
    .limit(1))[0]
  return !!row
}

/**
 * One-query fetch for the token, files and activity endpoints: the doc row
 * joined with the caller's workspace role. `actorUserId` null means anonymous,
 * so no role lookup.
 */
export async function getDocWithActorRole(
  docId: string,
  actorUserId: number | null
): Promise<DocAuthzRow | null> {
  const db = useDatabase()

  const row = (await db
    .select({
      ownerId: documents.ownerId,
      workspaceId: documents.workspaceId,
      accessMode: documents.accessMode,
      shareExpiresAt: documents.shareExpiresAt,
      shareNoDownload: documents.shareNoDownload,
      anonCreatorKeyHash: documents.anonCreatorKeyHash,
      theme: documents.theme,
      title: documents.title,
      description: documents.description,
      audience: documents.audience,
      language: documents.language,
      templateId: documents.templateId,
      // A guest has the role their share of THIS document gives
      // (edit → editor, view → viewer) and none without one.
      role: sql<WorkspaceRole | null>`case when ${workspaceMembers.role} = 'guest' then (
        select case ${documentShares.access} when 'edit' then 'editor' else 'viewer' end
        from ${documentShares}
        where ${documentShares.docId} = ${documents.docId} and ${documentShares.userId} = ${actorUserId ?? -1}
      ) else ${workspaceMembers.role} end`,
      isGuest: sql<boolean>`coalesce(${workspaceMembers.role} = 'guest', false)`,
      // Ownership of a doc in an SSO-enforcing workspace counts only
      // while the caller has an effective MEMBER role there (the join
      // above already carries the SSO condition, so NULL = no role; a
      // guest row is not a member role — guests are outside the IdP).
      ownerAccessSuspended: actorUserId === null
        ? sql<boolean>`false`
        : sql<boolean>`coalesce(${documents.ownerId} = ${actorUserId} and (${workspaceMembers.role} is null or ${workspaceMembers.role} = 'guest') and ${ssoEnforcedSql(documents.workspaceId)}, false)`
    })
    .from(documents)
    .leftJoin(
      workspaceMembers,
      actorUserId === null
        // Anonymous caller: construct a join predicate that never matches
        // so the leftJoin still runs but workspaceRole always comes back
        // null. Simpler than branching on two query shapes.
        ? sql`false`
        : and(
            eq(workspaceMembers.workspaceId, documents.workspaceId),
            eq(workspaceMembers.userId, actorUserId),
            // Single sign-on: no role without a current SSO grant
            // in a workspace that enforces it — same as getMemberRole.
            // Guests are outside the organisation: not held to it.
            or(eq(workspaceMembers.role, 'guest'), ssoSatisfiedSql(workspaceMembers.workspaceId, actorUserId))
          )
    )
    .where(eq(documents.docId, docId))
    .limit(1))[0]

  if (!row) return null

  return {
    ownerId: row.ownerId,
    workspaceId: row.workspaceId,
    accessMode: row.accessMode,
    anonCreatorKeyHash: row.anonCreatorKeyHash,
    theme: row.theme,
    workspaceRole: (row.role ?? null),
    isGuest: row.isGuest === true,
    ownerAccessSuspended: row.ownerAccessSuspended === true,
    shareExpiresAt: row.shareExpiresAt,
    shareNoDownload: row.shareNoDownload,
    title: row.title,
    description: row.description,
    audience: row.audience,
    language: row.language,
    templateId: row.templateId
  }
}

export async function createDoc(input: CreateDocInput): Promise<void> {
  const db = useDatabase()
  // Build the values object dynamically so omitted fields fall back to
  // the schema defaults rather than ending up as explicit nulls.
  const values: Record<string, unknown> = {
    docId: input.docId,
    ownerId: input.ownerId,
    workspaceId: input.workspaceId,
    accessMode: input.accessMode
  }
  if (input.title !== undefined) values.title = input.title
  if (input.description !== undefined) values.description = input.description
  if (input.audience !== undefined) values.audience = input.audience
  if (input.language !== undefined) values.language = input.language
  if (input.templateId !== undefined) values.templateId = input.templateId
  if (input.theme !== undefined) values.theme = input.theme
  if (input.anonCreatorKeyHash !== undefined) values.anonCreatorKeyHash = input.anonCreatorKeyHash
  if (input.anonTermsVersion !== undefined) values.anonTermsVersion = input.anonTermsVersion
  if (input.anonTermsAcceptedAt !== undefined) values.anonTermsAcceptedAt = input.anonTermsAcceptedAt
  await db.insert(documents).values(values as typeof documents.$inferInsert)
}

/**
 * Partial update of the meta fields a user (or the activity logger) can
 * change. Whichever fields are provided are written; omitted fields are
 * untouched. Bumps `lastActive` whenever any field changes so the
 * inactive-doc sweep sees the activity.
 *
 * No authz check — caller must have already decided the actor can edit.
 * Throws NotFoundError if no row matched. Setting an `accessMode` other
 * than `password-protected` also clears the stored password hash.
 */
export async function updateDocMeta(docId: string, update: MetaUpdate): Promise<void> {
  if (Object.keys(update).length === 0) return
  const db = useDatabase()
  // Leaving password mode drops the hash: a stale hash must never be
  // able to unlock the doc again (verify also refuses outside
  // password mode). Switching back requires setting a new password.
  const passwordReset = update.accessMode !== undefined && update.accessMode !== 'password-protected'
    ? { passwordHash: null }
    : {}
  const result = await db
    .update(documents)
    .set({ ...update, ...passwordReset, lastActive: new Date() })
    .where(eq(documents.docId, docId))
    .returning({ docId: documents.docId })
  if (result.length === 0) {
    throw new NotFoundError('Document')
  }
}

/**
 * Assign or clear the parent workspace. `null` detaches the doc.
 * No authz — callers gate via canManageDoc (source) + target-workspace
 * role. Bumps lastActive so the move surfaces in "recent" lists.
 */
export async function moveDocToWorkspace(docId: string, workspaceId: string | null): Promise<void> {
  const db = useDatabase()
  const result = await db
    .update(documents)
    .set({ workspaceId, lastActive: new Date() })
    .where(eq(documents.docId, docId))
    .returning({ docId: documents.docId })
  if (result.length === 0) {
    throw new NotFoundError('Document')
  }
}

/**
 * Insert a new documents row as a copy of the source. Every field the
 * caller cares about is passed explicitly so this doesn't silently
 * inherit future schema additions — new columns must be audited for
 * duplication safety.
 */
export interface DuplicateDocInput {
  newDocId: string
  ownerId: number | null
  workspaceId: string | null
  title: string
  accessMode: AccessMode
  passwordHash: string | null
  theme: DocTheme | null
  wordCount: number | null
  sizeBytes: number | null
  description: string
  audience: AudienceKind
  language: string
  templateId: string
  /** A copy of restricted content is restricted too (see `documents.moderation_restricted_at`). */
  moderationRestrictedAt: Date | null
  moderationReportId: string | null
}

export async function insertDuplicateDoc(input: DuplicateDocInput): Promise<void> {
  const db = useDatabase()
  await db.insert(documents).values({
    docId: input.newDocId,
    ownerId: input.ownerId,
    workspaceId: input.workspaceId,
    title: input.title,
    accessMode: input.accessMode,
    passwordHash: input.passwordHash,
    theme: input.theme,
    wordCount: input.wordCount ?? 0,
    sizeBytes: input.sizeBytes ?? 0,
    description: input.description,
    audience: input.audience,
    language: input.language,
    templateId: input.templateId,
    moderationRestrictedAt: input.moderationRestrictedAt,
    moderationReportId: input.moderationReportId
  })
}

/** The report behind a document's moderation restriction, if it has one. */
export async function getModerationRestriction(docId: string): Promise<{ restrictedAt: Date, reportId: string | null } | null> {
  const row = (await useDatabase().select({ at: documents.moderationRestrictedAt, reportId: documents.moderationReportId })
    .from(documents).where(eq(documents.docId, docId)).limit(1))[0]
  return row?.at ? { restrictedAt: row.at, reportId: row.reportId } : null
}

/**
 * Restrict (moderation decision) or lift (platform admin). Restricting
 * also makes the document private and drops its password in the same
 * statement; lifting changes nothing else (the owner re-shares).
 */
export async function setModerationRestriction(docId: string, restriction: { reportId: string } | null): Promise<void> {
  const set = restriction === null
    ? { moderationRestrictedAt: null, moderationReportId: null }
    : { accessMode: 'private' as const, passwordHash: null, moderationRestrictedAt: new Date(), moderationReportId: restriction.reportId }
  const result = await useDatabase().update(documents).set(set)
    .where(eq(documents.docId, docId)).returning({ docId: documents.docId })
  if (result.length === 0) throw new NotFoundError('Document')
}

/** Update the share-link controls. */
export async function setShareSettings(docId: string, settings: { shareExpiresAt: Date | null, shareNoDownload: boolean }): Promise<void> {
  const result = await useDatabase().update(documents).set(settings)
    .where(eq(documents.docId, docId))
    .returning({ docId: documents.docId })
  if (result.length === 0) throw new NotFoundError('Document')
}

/** Set the password hash AND flip accessMode to password-protected in one write. */
export async function setDocPassword(docId: string, passwordHash: string): Promise<void> {
  const db = useDatabase()
  await db
    .update(documents)
    .set({ passwordHash, accessMode: 'password-protected' })
    .where(eq(documents.docId, docId))
}

/**
 * Clear the password AND flip accessMode to open-edit. Called by
 * /password action=remove.
 */
export async function clearDocPassword(docId: string): Promise<void> {
  const db = useDatabase()
  await db
    .update(documents)
    .set({ passwordHash: null, accessMode: 'open-edit' })
    .where(eq(documents.docId, docId))
}

/**
 * Bump the lastActive timestamp. Called from the internal activity
 * logger on every `edit` event — separated from updateDocMeta because
 * it's hot-path and doesn't need the returning() check.
 */
export async function bumpLastActive(docId: string): Promise<void> {
  const db = useDatabase()
  await db
    .update(documents)
    .set({ lastActive: new Date() })
    .where(eq(documents.docId, docId))
}

/**
 * Delete just the documents row. The full cascade (S3 + activity +
 * uploads + sync notify) lives in documentLifecycle.deleteDocument.
 */
export async function deleteDocRow(docId: string): Promise<void> {
  const db = useDatabase()
  await db.delete(documents).where(eq(documents.docId, docId))
}

/**
 * List docs owned by a user — powers the "My Documents" dashboard.
 * workspaceId is included so the Move modal can preselect the doc's
 * current workspace.
 */
export async function listOwnedByUser(userId: number): Promise<Array<{
  docId: string
  title: string
  description: string
  language: string
  accessMode: AccessMode
  wordCount: number | null
  sizeBytes: number | null
  lastActive: Date
  workspaceId: string | null
}>> {
  const db = useDatabase()
  return db
    .select({
      docId: documents.docId,
      title: documents.title,
      description: documents.description,
      language: documents.language,
      accessMode: documents.accessMode,
      wordCount: documents.wordCount,
      sizeBytes: documents.sizeBytes,
      lastActive: documents.lastActive,
      workspaceId: documents.workspaceId
    })
    .from(documents)
    .where(eq(documents.ownerId, userId))
    .orderBy(sql`${documents.lastActive} desc`)
}

/**
 * Every docId we know about. Used by orphan-cleanup to reconcile
 * against S3's prefix list.
 */
export async function listAllDocIds(): Promise<string[]> {
  const db = useDatabase()
  const rows = await db.select({ docId: documents.docId }).from(documents)
  return rows.map(r => r.docId)
}

/**
 * List every docId in a workspace. Used by the membership-change path
 * (kick JWTs) and the workspace delete cascade.
 */
export async function listDocIdsInWorkspace(workspaceId: string): Promise<string[]> {
  const db = useDatabase()
  const rows = await db
    .select({ docId: documents.docId })
    .from(documents)
    .where(eq(documents.workspaceId, workspaceId))
  return rows.map(r => r.docId)
}

/**
 * Full doc list for a workspace with per-row "isOwner" flag for the
 * calling user. Used by GET /api/workspaces/:id.
 */
export async function listWorkspaceDocsWithOwnerFlag(
  workspaceId: string,
  actorUserId: number
): Promise<Array<{
  docId: string
  title: string
  description: string
  language: string
  accessMode: AccessMode
  wordCount: number | null
  sizeBytes: number | null
  lastActive: Date
  ownerId: number | null
  isOwner: boolean
}>> {
  const db = useDatabase()
  return db
    .select({
      docId: documents.docId,
      title: documents.title,
      description: documents.description,
      language: documents.language,
      accessMode: documents.accessMode,
      wordCount: documents.wordCount,
      sizeBytes: documents.sizeBytes,
      lastActive: documents.lastActive,
      ownerId: documents.ownerId,
      isOwner: sql<boolean>`${documents.ownerId} = ${actorUserId}`
    })
    .from(documents)
    .where(eq(documents.workspaceId, workspaceId))
    .orderBy(sql`${documents.lastActive} desc`)
}
