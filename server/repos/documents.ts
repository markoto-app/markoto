import { and, eq, inArray, isNull, lt, sql, type SQL } from 'drizzle-orm'
import type { DocTheme } from '~~/shared/types/theme'
import type { AudienceKind } from '~~/shared/audiences'
import type { DocListSort, SortDirection } from '~~/shared/api/explorer'
import { documents, users } from '../db/schema'
import { useDatabase } from '../db/client'
import { NotFoundError } from './errors'
import { proofUserId, type DocAccess, type SystemActor, type UserScope, type WorkspaceAccess } from './proofs'
import { docScopeSql, type FolderScope } from './folders'

// Documents repository: every read/write of the `documents` table goes through
// here, so endpoints work with domain shapes (`DocSnapshot`) instead of
// Drizzle rows. Reads of a document's content and every write take a
// `DocAccess` proof (server/repos/proofs) and query the id FROM the proof;
// the access lookup itself (`getDocWithActorRole`) lives in
// `server/repos/access/docAuthz.ts`.

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
  /** One-line "what this doc is about", empty string means not set. */
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
  /** A folder of the document's scope, checked by the caller (`createDocument`). */
  folderId?: string
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
export async function getDoc(doc: DocAccess<'view'>): Promise<DocSnapshot | null> {
  const docId = doc.docId
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

export async function createDoc(
  creator: UserScope | null,
  workspace: WorkspaceAccess<'editor'> | null,
  input: Omit<CreateDocInput, 'ownerId' | 'workspaceId'>
): Promise<void> {
  // The owner and the workspace come from the proofs, and a workspace proof
  // must be the creator's own: nobody files a document into a workspace on
  // someone else's membership.
  if (workspace && (!creator || proofUserId(workspace) !== creator.userId)) {
    throw new Error('createDoc: the workspace proof belongs to another actor')
  }
  const db = useDatabase()
  // Build the values object dynamically so omitted fields fall back to
  // the schema defaults rather than ending up as explicit nulls.
  const values: Record<string, unknown> = {
    docId: input.docId,
    ownerId: creator?.userId ?? null,
    workspaceId: workspace?.workspaceId ?? null,
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
  if (input.folderId !== undefined) values.folderId = input.folderId
  await db.insert(documents).values(values as typeof documents.$inferInsert)
}

/**
 * Partial update of the meta fields a user (or the activity logger) can
 * change. Whichever fields are provided are written; omitted fields are
 * untouched. Bumps `lastActive` whenever any field changes so the
 * inactive-doc sweep sees the activity.
 *
 * No authz check: caller must have already decided the actor can edit.
 * Throws NotFoundError if no row matched. Setting an `accessMode` other
 * than `password-protected` also clears the stored password hash.
 */
export async function updateDocMeta(doc: DocAccess<'write'>, update: MetaUpdate): Promise<void> {
  if (Object.keys(update).length === 0) return
  const docId = doc.docId
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
 * No authz: callers gate via canManageDoc (source) + target-workspace
 * role. Bumps lastActive so the move surfaces in "recent" lists.
 */
export async function moveDocToWorkspace(doc: DocAccess<'manage'>, target: WorkspaceAccess<'editor'> | null): Promise<void> {
  const docId = doc.docId
  const workspaceId = target?.workspaceId ?? null
  const db = useDatabase()
  // The document leaves its folder: folders belong to one scope.
  const result = await db
    .update(documents)
    .set({ workspaceId, folderId: null, lastActive: new Date() })
    .where(eq(documents.docId, docId))
    .returning({ docId: documents.docId })
  if (result.length === 0) {
    throw new NotFoundError('Document')
  }
}

/**
 * Insert a new documents row as a copy of the source. Every field the
 * caller cares about is passed explicitly so this doesn't silently
 * inherit future schema additions, new columns must be audited for
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

/**
 * The copy's owner and workspace are decided by the duplicate use case
 * (`utils/documents/duplicateDocument.ts`); the source must be readable.
 */
export async function insertDuplicateDoc(source: DocAccess<'view'>, input: DuplicateDocInput): Promise<void> {
  if (source.docId === input.newDocId) throw new Error('insertDuplicateDoc: copy id equals the source id')
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
export async function getModerationRestriction(doc: DocAccess<'view'>): Promise<{ restrictedAt: Date, reportId: string | null } | null> {
  const row = (await useDatabase().select({ at: documents.moderationRestrictedAt, reportId: documents.moderationReportId })
    .from(documents).where(eq(documents.docId, doc.docId)).limit(1))[0]
  return row?.at ? { restrictedAt: row.at, reportId: row.reportId } : null
}

/**
 * Restrict (moderation decision) or lift (platform admin). Restricting
 * also makes the document private and drops its password in the same
 * statement; lifting changes nothing else (the owner re-shares).
 */
export async function setModerationRestriction(doc: DocAccess<'manage'>, restriction: { reportId: string } | null): Promise<void> {
  const set = restriction === null
    ? { moderationRestrictedAt: null, moderationReportId: null }
    : { accessMode: 'private' as const, passwordHash: null, moderationRestrictedAt: new Date(), moderationReportId: restriction.reportId }
  const result = await useDatabase().update(documents).set(set)
    .where(eq(documents.docId, doc.docId)).returning({ docId: documents.docId })
  if (result.length === 0) throw new NotFoundError('Document')
}

/** Update the share-link controls. */
export async function setShareSettings(doc: DocAccess<'manage'>, settings: { shareExpiresAt: Date | null, shareNoDownload: boolean }): Promise<void> {
  const result = await useDatabase().update(documents).set(settings)
    .where(eq(documents.docId, doc.docId))
    .returning({ docId: documents.docId })
  if (result.length === 0) throw new NotFoundError('Document')
}

/** Set the password hash AND flip accessMode to password-protected in one write. */
export async function setDocPassword(doc: DocAccess<'manage'>, passwordHash: string): Promise<void> {
  const docId = doc.docId
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
export async function clearDocPassword(doc: DocAccess<'manage'>): Promise<void> {
  const docId = doc.docId
  const db = useDatabase()
  await db
    .update(documents)
    .set({ passwordHash: null, accessMode: 'open-edit' })
    .where(eq(documents.docId, docId))
}

/**
 * Delete just the documents row. The full cascade (S3 + activity +
 * uploads + sync notify) lives in documentLifecycle.deleteDocument.
 */
export async function deleteDocRow(doc: DocAccess<'delete'>): Promise<void> {
  const docId = doc.docId
  const db = useDatabase()
  await db.delete(documents).where(eq(documents.docId, docId))
}

/**
 * List docs owned by a user, powers the "My Documents" dashboard.
 * workspaceId is included so the Move modal can preselect the doc's
 * current workspace.
 */
export async function listOwnedByUser(self: UserScope): Promise<Array<{
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
    .where(eq(documents.ownerId, self.userId))
    .orderBy(sql`${documents.lastActive} desc`)
}

/**
 * Every docId we know about. Used by orphan-cleanup to reconcile
 * against S3's prefix list.
 */
export async function listAllDocIds(_by: SystemActor): Promise<string[]> {
  const db = useDatabase()
  const rows = await db.select({ docId: documents.docId }).from(documents)
  return rows.map(r => r.docId)
}

/**
 * List every docId in a workspace. Used by the membership-change path
 * (kick JWTs) and the workspace delete cascade.
 */
export async function listDocIdsInWorkspace(ws: WorkspaceAccess<'member'>): Promise<string[]> {
  const workspaceId = ws.workspaceId
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
export async function listWorkspaceDocsWithOwnerFlag(ws: WorkspaceAccess<'member'>): Promise<Array<{
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
  const workspaceId = ws.workspaceId
  // `isOwner` is relative to whoever holds the proof (no user: false).
  const actorUserId = proofUserId(ws) ?? -1
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

/**
 * The metadata a viewer of the document gets (`GET /api/docs/:id/meta`):
 * an explicit projection without the password hash or creator key.
 */
export async function getDocMetaForViewer(doc: DocAccess<'view'>) {
  return (await useDatabase()
    .select({
      id: documents.id,
      docId: documents.docId,
      ownerId: documents.ownerId,
      title: documents.title,
      accessMode: documents.accessMode,
      sizeBytes: documents.sizeBytes,
      wordCount: documents.wordCount,
      theme: documents.theme,
      description: documents.description,
      audience: documents.audience,
      language: documents.language,
      templateId: documents.templateId,
      createdAt: documents.createdAt,
      lastActive: documents.lastActive
    })
    .from(documents)
    .where(eq(documents.docId, doc.docId))
    .limit(1))[0] ?? null
}

/** What the audit trail keeps of a document that is about to be deleted. */
export async function getDocForDeletion(doc: DocAccess<'delete'>): Promise<{ title: string, accessMode: AccessMode, ownerId: number | null, workspaceId: string | null } | null> {
  return (await useDatabase()
    .select({ title: documents.title, accessMode: documents.accessMode, ownerId: documents.ownerId, workspaceId: documents.workspaceId })
    .from(documents)
    .where(eq(documents.docId, doc.docId))
    .limit(1))[0] ?? null
}

/** Anonymous documents (no owner, no workspace) without activity since `cutoff`: the inactive-doc sweep's candidates. */
export async function listInactiveAnonymousDocIds(_by: SystemActor, cutoff: Date): Promise<Array<{ docId: string }>> {
  return useDatabase()
    .select({ docId: documents.docId })
    .from(documents)
    .where(and(isNull(documents.ownerId), isNull(documents.workspaceId), lt(documents.lastActive, cutoff)))
}

/** One row of a paginated document list (explorer, AI and MCP list tools). */
export interface DocListRow {
  docId: string
  title: string
  description: string
  language: string
  accessMode: AccessMode
  wordCount: number | null
  sizeBytes: number | null
  folderId: string | null
  ownerId: number | null
  ownerName: string | null
  isOwner: boolean
  createdAt: Date
  updatedAt: Date
  lastActive: Date
}

export interface DocListQuery {
  /** `null` = the scope's root, a folder id = that folder, `'all'` = every document of the scope. */
  folder: string | null | 'all'
  sort: DocListSort
  dir: SortDirection
  /** Only documents of this owner. */
  ownerId?: number
  /** Only these documents (rows for search hits). */
  docIds?: readonly string[]
  /** Keyset position from the previous page. */
  after?: { key: string, docId: string }
  limit: number
}

const SORT_COLUMN: Record<DocListSort, SQL> = {
  updated: sql`${documents.updatedAt}`,
  created: sql`${documents.createdAt}`,
  active: sql`${documents.lastActive}`,
  title: sql`lower(${documents.title})`
}

/**
 * A page of the scope's documents (a workspace for any member, or the
 * user's personal documents), in a stable keyset order: the sort column,
 * then the document id. `total` counts every match (all pages). The sort
 * key travels as text so timestamps keep their microseconds.
 */
export async function listScopeDocs(scope: FolderScope, q: DocListQuery): Promise<{ rows: Array<DocListRow & { sortKey: string }>, total: number }> {
  const actorId = proofUserId(scope) ?? -1
  const col = SORT_COLUMN[q.sort]
  const isTimestamp = q.sort !== 'title'
  const filters: SQL[] = [docScopeSql(scope)]
  if (q.folder === null) filters.push(sql`${documents.folderId} IS NULL`)
  else if (q.folder !== 'all') filters.push(sql`${documents.folderId} = ${q.folder}`)
  if (q.ownerId !== undefined) filters.push(sql`${documents.ownerId} = ${q.ownerId}`)
  if (q.docIds !== undefined) {
    if (q.docIds.length === 0) return { rows: [], total: 0 }
    filters.push(inArray(documents.docId, [...q.docIds]))
  }
  const base = and(...filters)
  const page: SQL[] = []
  if (q.after) {
    const key = isTimestamp ? sql`${q.after.key}::timestamptz` : sql`${q.after.key}`
    page.push(q.dir === 'asc'
      ? sql`(${col}, ${documents.docId}) > (${key}, ${q.after.docId})`
      : sql`(${col}, ${documents.docId}) < (${key}, ${q.after.docId})`)
  }
  const db = useDatabase()
  const order = q.dir === 'asc' ? sql`${col} ASC, ${documents.docId} ASC` : sql`${col} DESC, ${documents.docId} DESC`
  const [rows, count] = await Promise.all([
    db.select({
      docId: documents.docId,
      title: documents.title,
      description: documents.description,
      language: documents.language,
      accessMode: documents.accessMode,
      wordCount: documents.wordCount,
      sizeBytes: documents.sizeBytes,
      folderId: documents.folderId,
      ownerId: documents.ownerId,
      ownerName: users.name,
      isOwner: sql<boolean>`coalesce(${documents.ownerId} = ${actorId}, false)`,
      createdAt: documents.createdAt,
      updatedAt: documents.updatedAt,
      lastActive: documents.lastActive,
      sortKey: sql<string>`(${col})::text`
    })
      .from(documents)
      .leftJoin(users, eq(users.id, documents.ownerId))
      .where(page.length > 0 ? and(base, ...page) : base)
      .orderBy(order)
      .limit(q.limit),
    db.select({ n: sql<number>`count(*)::int` }).from(documents).where(base)
  ])
  return { rows, total: Number(count[0]?.n ?? 0) }
}

/** Title and placement of a document, for an AI / MCP answer or a bulk result. */
export async function getDocPlacement(doc: DocAccess<'view'>): Promise<{ title: string, workspaceId: string | null, folderId: string | null, ownerId: number | null } | null> {
  return (await useDatabase()
    .select({ title: documents.title, workspaceId: documents.workspaceId, folderId: documents.folderId, ownerId: documents.ownerId })
    .from(documents)
    .where(eq(documents.docId, doc.docId))
    .limit(1))[0] ?? null
}

/**
 * Rename a document (the row; the live title in the Y.Doc is set by the
 * caller). Counts as an edit for "last edited".
 */
export async function renameDoc(doc: DocAccess<'edit'>, title: string): Promise<void> {
  const now = new Date()
  const result = await useDatabase().update(documents)
    .set({ title, updatedAt: now, lastActive: now })
    .where(eq(documents.docId, doc.docId))
    .returning({ docId: documents.docId })
  if (result.length === 0) throw new NotFoundError('Document')
}
