import { and, eq, exists, ne, notInArray, sql } from 'drizzle-orm'
import {
  activityLog,
  aiSessionMessages,
  aiSessions,
  auditLog,
  consentLog,
  dataExportJobs,
  documentComments,
  documents,
  users,
  workspaceKnowledge,
  workspaceMembers,
  workspaces
} from '../db/schema'
import { useDatabase } from '../db/client'
import type { UserScope } from './proofs'

// What deleting an account would touch (the preview the user sees before
// confirming). Read-only; every query is keyed on the proof's user, and the
// workspace queries only reach workspaces that user is a member of.

const count = sql<number>`count(*)::int`

/** Workspaces of `user` only: a membership row of theirs must exist. */
function memberOf(user: UserScope, workspaceId: string) {
  return exists(useDatabase().select({ one: sql`1` }).from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, user.userId))))
}

export async function getDeletionSubject(user: UserScope): Promise<{ id: number, stripeCustomerId: string | null } | null> {
  return (await useDatabase().select({ id: users.id, stripeCustomerId: users.stripeCustomerId })
    .from(users).where(eq(users.id, user.userId)).limit(1))[0] ?? null
}

export async function listOwnedDocsForDeletion(user: UserScope) {
  return useDatabase()
    .select({ docId: documents.docId, title: documents.title, accessMode: documents.accessMode, workspaceId: documents.workspaceId })
    .from(documents)
    .where(eq(documents.ownerId, user.userId))
}

/** Comments the user wrote on documents they don't own (anonymised, not deleted). */
export async function countCommentsOnOthersDocs(user: UserScope, ownedDocIds: readonly string[]): Promise<number> {
  const where = ownedDocIds.length === 0
    ? eq(documentComments.authorId, user.userId)
    // Bound parameters, never ids spliced into the SQL text.
    : and(eq(documentComments.authorId, user.userId), notInArray(documentComments.docId, [...ownedDocIds]))
  return Number((await useDatabase().select({ count }).from(documentComments).where(where))[0]?.count ?? 0)
}

export async function listMembershipsForDeletion(user: UserScope) {
  return useDatabase()
    .select({ workspaceId: workspaceMembers.workspaceId, role: workspaceMembers.role, ownerId: workspaces.ownerId, wsName: workspaces.name })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.workspaceId, workspaceMembers.workspaceId))
    .where(eq(workspaceMembers.userId, user.userId))
}

/** The other (non-guest) members of one of the user's workspaces, longest-serving first. */
export async function listCoMembers(user: UserScope, workspaceId: string) {
  return useDatabase()
    .select({ userId: workspaceMembers.userId, role: workspaceMembers.role, joinedAt: workspaceMembers.joinedAt, name: users.name })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(and(
      eq(workspaceMembers.workspaceId, workspaceId),
      sql`${workspaceMembers.userId} <> ${user.userId}`,
      // Guests are not the team: never promoted, and a workspace left
      // with only guests counts as having no other member.
      ne(workspaceMembers.role, 'guest'),
      memberOf(user, workspaceId)
    ))
    .orderBy(workspaceMembers.joinedAt)
}

/** Documents and knowledge files in one of the user's workspaces. */
export async function countWorkspaceContents(user: UserScope, workspaceId: string): Promise<{ docCount: number, knowledgeCount: number }> {
  const db = useDatabase()
  const docs = await db.select({ count }).from(documents).where(and(eq(documents.workspaceId, workspaceId), memberOf(user, workspaceId)))
  const knowledge = await db.select({ count }).from(workspaceKnowledge).where(and(eq(workspaceKnowledge.workspaceId, workspaceId), memberOf(user, workspaceId)))
  return { docCount: Number(docs[0]?.count ?? 0), knowledgeCount: Number(knowledge[0]?.count ?? 0) }
}

/** The account's AI sessions / messages, export jobs and the rows kept anonymised. */
export async function countAccountRecords(user: UserScope) {
  const db = useDatabase()
  const [sessions, messages, exportJobs, activity, audit, consent] = await Promise.all([
    db.select({ count }).from(aiSessions).where(eq(aiSessions.initiatorUserId, user.userId)),
    db.select({ count }).from(aiSessionMessages).where(eq(aiSessionMessages.userId, user.userId)),
    db.select({ jobId: dataExportJobs.jobId, s3Key: dataExportJobs.s3Key }).from(dataExportJobs).where(eq(dataExportJobs.userId, user.userId)),
    db.select({ count }).from(activityLog).where(eq(activityLog.userId, user.userId)),
    db.select({ count }).from(auditLog).where(eq(auditLog.actorUserId, user.userId)),
    db.select({ count }).from(consentLog).where(eq(consentLog.userId, user.userId))
  ])
  return {
    aiSessions: Number(sessions[0]?.count ?? 0),
    aiSessionMessages: Number(messages[0]?.count ?? 0),
    exportJobs,
    activityLog: Number(activity[0]?.count ?? 0),
    auditLog: Number(audit[0]?.count ?? 0),
    consentLog: Number(consent[0]?.count ?? 0)
  }
}
