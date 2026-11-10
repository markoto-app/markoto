import { and, eq, ne, sql } from 'drizzle-orm'
import { workspaces, workspaceMembers, documents } from '../db/schema'
import type { WorkspaceRole } from '../../shared/utils/docPermissions'
import type { DocTheme } from '~~/shared/types/theme'
import { useDatabase } from '../utils/database'
import { NotFoundError } from './errors'

// Workspaces repository. Two transactional paths stand out:
//   - createWorkspace: insert the row AND enroll the creator as admin
//     in the SAME transaction, so a half-created workspace (exists, has
//     no admin) never lands in the DB.
//   - deleteWorkspaceRow: just the workspace row. The per-doc cascade
//     (S3 + sync notify etc.) lives in the endpoint because it needs
//     deleteDocument() which has side effects beyond Postgres.

export interface WorkspaceRow {
  workspaceId: string
  ownerId: number
  name: string
  description: string | null
  defaultTheme: DocTheme | null
  /** Brand kit (WP10): the workspace design is locked for every document. */
  brandLocked: boolean
  createdAt: Date
}

export interface CreateWorkspaceInput {
  workspaceId: string
  ownerId: number
  name: string
  // `null` for "no description provided" — the column is nullable. The
  // POST handler validates + normalises empty strings to null before
  // calling here.
  description: string | null
}

export interface WorkspaceUpdate {
  name?: string
  description?: string | null
  // `null` clears the default; `undefined` leaves the field untouched.
  defaultTheme?: DocTheme | null
  /** Brand kit (WP10): lock the workspace design for every document. */
  brandLocked?: boolean
}

export interface UserWorkspaceSummary {
  workspaceId: string
  name: string
  description: string | null
  createdAt: Date
  role: WorkspaceRole
  docCount: number
  lastActive: Date | null
}

export async function getWorkspace(workspaceId: string): Promise<WorkspaceRow | null> {
  const db = useDatabase()
  const row = (await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.workspaceId, workspaceId))
    .limit(1))[0]
  return row ?? null
}

/**
 * Create a workspace AND enroll the creator as the first admin. Both
 * writes run in a single transaction — if the admin insert fails, the
 * workspace row is rolled back, avoiding the "exists but has no admin"
 * state that would otherwise violate the ≥1-admin invariant at t=0.
 */
export async function createWorkspace(input: CreateWorkspaceInput): Promise<void> {
  const db = useDatabase()
  await db.transaction(async (tx) => {
    await tx.insert(workspaces).values({
      workspaceId: input.workspaceId,
      ownerId: input.ownerId,
      name: input.name,
      description: input.description
    })
    await tx.insert(workspaceMembers).values({
      workspaceId: input.workspaceId,
      userId: input.ownerId,
      role: 'admin'
    })
  })
}

/**
 * Partial update of the workspace row (name/description). Passing an
 * empty update is a no-op (won't hit the DB).
 */
export async function updateWorkspace(
  workspaceId: string,
  update: WorkspaceUpdate
): Promise<void> {
  if (Object.keys(update).length === 0) return
  const db = useDatabase()
  const result = await db
    .update(workspaces)
    .set(update)
    .where(eq(workspaces.workspaceId, workspaceId))
    .returning({ workspaceId: workspaces.workspaceId })
  if (result.length === 0) {
    throw new NotFoundError('Workspace')
  }
}

/**
 * Count workspaces owned (created) by a user. Only counts `ownerId` —
 * a user invited to others' workspaces isn't included. Used to enforce
 * the per-user creation cap so one account can't spawn thousands of
 * empty workspaces to fan out uploads across them.
 */
export async function countOwnedWorkspacesByUser(userId: number): Promise<number> {
  const db = useDatabase()
  const rows = await db.select({ n: sql<number>`count(*)::int` })
    .from(workspaces)
    .where(eq(workspaces.ownerId, userId))
  return rows[0]?.n ?? 0
}

/**
 * Delete just the workspaces row. `workspace_members` rows cascade via
 * the FK; documents have ON DELETE SET NULL on `workspace_id`, so docs
 * survive but detach — callers that want to cascade-delete docs must
 * do that first (see /api/workspaces/:id delete endpoint).
 */
export async function deleteWorkspaceRow(workspaceId: string): Promise<void> {
  const db = useDatabase()
  await db.delete(workspaces).where(eq(workspaces.workspaceId, workspaceId))
}

/**
 * Per-user workspace list for the dashboard card view. Aggregates
 * doc count + last activity per workspace in one query.
 */
export async function listWorkspacesForUser(userId: number): Promise<UserWorkspaceSummary[]> {
  const db = useDatabase()
  return db.select({
    workspaceId: workspaces.workspaceId,
    name: workspaces.name,
    description: workspaces.description,
    createdAt: workspaces.createdAt,
    role: workspaceMembers.role,
    docCount: sql<number>`count(${documents.docId})::int`,
    lastActive: sql<Date | null>`max(${documents.lastActive})`
  })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.workspaceId, workspaceMembers.workspaceId))
    .leftJoin(documents, eq(documents.workspaceId, workspaces.workspaceId))
    .where(and(eq(workspaceMembers.userId, userId), ne(workspaceMembers.role, 'guest')))
    .groupBy(
      workspaces.workspaceId,
      workspaces.name,
      workspaces.description,
      workspaces.createdAt,
      workspaceMembers.role
    )
    .orderBy(sql`coalesce(max(${documents.lastActive}), ${workspaces.createdAt}) desc`) as Promise<UserWorkspaceSummary[]>
}
