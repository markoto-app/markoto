import { and, eq, sql } from 'drizzle-orm'
import type { DocTheme } from '~~/shared/types/theme'
import type { AudienceKind } from '~~/shared/audiences'
import { documents, workspaceMembers, workspaces, users } from '../db/schema'
import { alias } from 'drizzle-orm/pg-core'
import type { WorkspaceRole } from '../../shared/utils/docPermissions'
import { useDatabase } from '../utils/database'
import { NotFoundError } from './errors'

// Documents repository.
//
// Every endpoint that reads or writes the `documents` table goes through
// this module. Benefits:
//   - One place owns the DB schema coupling; endpoints work with domain
//     shapes (`DocSnapshot`, `DocAuthzRow`) instead of Drizzle row types.
//   - The "fetch doc + joined workspace role" pattern used by token,
//     files, and activity endpoints lives in `getDocWithActorRole`
//     rather than being inlined in three places.
//   - Unit-testable via `createDocumentsRepo(db)` that takes an explicit
//     Drizzle instance. Default export reads from `useDatabase()`.

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
   * Whether the parent workspace (if any) has `(+)` AI-workspace
   * billing enabled. Carried alongside the authz fields so the
   * editor can surface an "AI workspace" banner on load without a
   * second round-trip. NULL for standalone docs.
   */
  workspaceAiEnabled: boolean | null
  /**
   * Display info for the `(+)` sponsor when AI-workspace billing is
   * on. Lets the editor render the sponsor's avatar + name without a
   * second round-trip. NULL when AI is off, the workspace has no
   * billing owner, or the sponsor row is missing.
   */
  workspaceBillingOwner: {
    id: number
    name: string
    avatarUrl: string | null
  } | null
  /**
   * Document context fields. Surfaced through the token endpoint so the
   * editor can hydrate the Document tab + new-doc-derived UI before the
   * Y.js sync completes. Source-of-truth lives in the documents row;
   * ymeta.* mirrors are bridged for live updates.
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
   * Optional context fields chosen at creation time via the new-doc
   * dialog. Each falls back to the schema default if omitted, so the
   * "Just give me a blank doc" path can pass nothing and get sensible
   * values without the caller having to know the defaults.
   */
  title?: string
  description?: string
  audience?: AudienceKind
  language?: string
  templateId?: string
  theme?: DocTheme | null
  /** Anonymous docs only: SHA-256 of the creating browser's creator key. */
  anonCreatorKeyHash?: string
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
}

/**
 * Fetch the full document row. Returns null (not throws) for missing
 * docs so callers can distinguish "not found" from genuine errors —
 * handlers that want 404 on missing translate explicitly.
 */
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
    createdAt: row.createdAt,
    lastActive: row.lastActive
  }
}

/**
 * Exists check without pulling the whole row. Cheaper than getDoc when
 * all we need is "yes/no" (e.g. internal/activity).
 */
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
 * The one-query fetch used by token, files, and activity endpoints:
 * doc row joined with the caller's workspace role (if any). Replaces
 * the "fetch doc, then fetch role conditionally" two-step that was
 * inlined in several places.
 *
 * `actorUserId` null ⇒ anonymous caller ⇒ no role lookup performed.
 */
export async function getDocWithActorRole(
  docId: string,
  actorUserId: number | null
): Promise<DocAuthzRow | null> {
  const db = useDatabase()

  // Alias `users` so we can pull the `(+)` billing owner without
  // colliding with any future join against `users` for doc.ownerId.
  const sponsor = alias(users, 'sponsor')

  const row = (await db
    .select({
      ownerId: documents.ownerId,
      workspaceId: documents.workspaceId,
      accessMode: documents.accessMode,
      anonCreatorKeyHash: documents.anonCreatorKeyHash,
      theme: documents.theme,
      title: documents.title,
      description: documents.description,
      audience: documents.audience,
      language: documents.language,
      templateId: documents.templateId,
      role: workspaceMembers.role,
      workspaceAiEnabled: workspaces.aiEnabled,
      sponsorId: sponsor.id,
      sponsorName: sponsor.name,
      sponsorAvatar: sponsor.avatarUrl
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
            eq(workspaceMembers.userId, actorUserId)
          )
    )
    // Second leftJoin to pull `(+)` state for the doc's parent workspace
    // (if any). Standalone docs get NULL here — the editor-side check
    // treats null as "no AI-workspace banner", which is correct.
    .leftJoin(workspaces, eq(workspaces.workspaceId, documents.workspaceId))
    // Third leftJoin: the billing owner's profile for the AI-workspace
    // indicator. NULL when the workspace is off or has no sponsor.
    .leftJoin(sponsor, eq(sponsor.id, workspaces.billingOwnerId))
    .where(eq(documents.docId, docId))
    .limit(1))[0]

  if (!row) return null
  // Only surface the sponsor when `(+)` is actually on — otherwise the
  // client would render an "AI workspace by X" badge for a disabled
  // state, which reads as a bug.
  const billingOwner = row.workspaceAiEnabled && row.sponsorId !== null && row.sponsorName !== null
    ? { id: row.sponsorId, name: row.sponsorName, avatarUrl: row.sponsorAvatar }
    : null

  return {
    ownerId: row.ownerId,
    workspaceId: row.workspaceId,
    accessMode: row.accessMode,
    anonCreatorKeyHash: row.anonCreatorKeyHash,
    theme: row.theme,
    workspaceRole: (row.role ?? null),
    workspaceAiEnabled: row.workspaceAiEnabled,
    workspaceBillingOwner: billingOwner,
    title: row.title,
    description: row.description,
    audience: row.audience,
    language: row.language,
    templateId: row.templateId
  }
}

/**
 * Create a new doc row. Title defaults to "Untitled" via the schema.
 */
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
    templateId: input.templateId
  })
}

/**
 * Set the password hash AND flip accessMode to password-protected in one
 * write. Called by /password action=set.
 */
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
