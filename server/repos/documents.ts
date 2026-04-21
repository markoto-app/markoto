import { and, eq, sql } from 'drizzle-orm'
import type { DocTheme } from '~~/shared/types/theme'
import { documents, workspaceMembers } from '../db/schema'
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
  createdAt: Date
  lastActive: Date
}

export interface DocAuthzRow {
  ownerId: number | null
  workspaceId: string | null
  accessMode: AccessMode
  theme: DocTheme | null
  workspaceRole: WorkspaceRole | null
}

export interface CreateDocInput {
  docId: string
  ownerId: number | null
  workspaceId: string | null
  accessMode: AccessMode
}

export interface MetaUpdate {
  title?: string
  accessMode?: AccessMode
  wordCount?: number
  sizeBytes?: number
  theme?: DocTheme | null
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

  const row = (await db
    .select({
      ownerId: documents.ownerId,
      workspaceId: documents.workspaceId,
      accessMode: documents.accessMode,
      theme: documents.theme,
      role: workspaceMembers.role
    })
    .from(documents)
    .leftJoin(
      workspaceMembers,
      actorUserId !== null
        ? and(
          eq(workspaceMembers.workspaceId, documents.workspaceId),
          eq(workspaceMembers.userId, actorUserId)
        )
        // Anonymous caller: construct a join predicate that never matches
        // so the leftJoin still runs but workspaceRole always comes back
        // null. Simpler than branching on two query shapes.
        : sql`false`
    )
    .where(eq(documents.docId, docId))
    .limit(1))[0]

  if (!row) return null
  return {
    ownerId: row.ownerId,
    workspaceId: row.workspaceId,
    accessMode: row.accessMode,
    theme: row.theme,
    workspaceRole: (row.role ?? null) as WorkspaceRole | null
  }
}

/**
 * Create a new doc row. Title defaults to "Untitled" via the schema.
 */
export async function createDoc(input: CreateDocInput): Promise<void> {
  const db = useDatabase()
  await db.insert(documents).values({
    docId: input.docId,
    ownerId: input.ownerId,
    workspaceId: input.workspaceId,
    accessMode: input.accessMode
  })
}

/**
 * Partial update of the meta fields a user (or the activity logger) can
 * change. Whichever fields are provided are written; omitted fields are
 * untouched. Bumps `lastActive` whenever any field changes so the
 * inactive-doc sweep sees the activity.
 *
 * No authz check — caller must have already decided the actor can edit.
 * Throws NotFoundError if no row matched.
 */
export async function updateDocMeta(docId: string, update: MetaUpdate): Promise<void> {
  if (Object.keys(update).length === 0) return
  const db = useDatabase()
  const result = await db
    .update(documents)
    .set({ ...update, lastActive: new Date() })
    .where(eq(documents.docId, docId))
    .returning({ docId: documents.docId })
  if (result.length === 0) {
    throw new NotFoundError('Document')
  }
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
 */
export async function listOwnedByUser(userId: number): Promise<Array<{
  docId: string
  title: string
  accessMode: AccessMode
  wordCount: number | null
  sizeBytes: number | null
  lastActive: Date
}>> {
  const db = useDatabase()
  return db
    .select({
      docId: documents.docId,
      title: documents.title,
      accessMode: documents.accessMode,
      wordCount: documents.wordCount,
      sizeBytes: documents.sizeBytes,
      lastActive: documents.lastActive
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
