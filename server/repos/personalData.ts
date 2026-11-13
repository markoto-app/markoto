import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import {
  abuseReports,
  activityLog,
  aiSessionMessages,
  aiSessions,
  auditLog,
  consentLog,
  documentComments,
  documentShares,
  documents,
  moderationNotices,
  ssoConnections,
  themes,
  userIdentities,
  users,
  workspaceBrandAssets,
  workspaceMembers,
  workspaces
} from '../db/schema'
import { useDatabase } from '../db/client'
import type { UserScope } from './proofs'

// The personal data of one account, read for its GDPR Art. 15 / 20 export
// (`server/utils/privacy/dataExport.ts` formats it). Every query is keyed
// on the proof's user; the export worker acts for the user who asked.

export type UserProfileRow = typeof users.$inferSelect

export async function getProfileForExport(user: UserScope): Promise<UserProfileRow | null> {
  return (await useDatabase().select().from(users).where(eq(users.id, user.userId)).limit(1))[0] ?? null
}

export async function listOwnedDocumentsForExport(user: UserScope) {
  return useDatabase().select().from(documents).where(eq(documents.ownerId, user.userId))
}

export async function listAuthoredComments(user: UserScope) {
  return useDatabase().select().from(documentComments)
    .where(eq(documentComments.authorId, user.userId))
    .orderBy(asc(documentComments.createdAtMs))
}

export async function listMembershipsForExport(user: UserScope) {
  return useDatabase()
    .select({
      workspaceId: workspaceMembers.workspaceId,
      role: workspaceMembers.role,
      joinedAt: workspaceMembers.joinedAt,
      workspaceName: workspaces.name
    })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.workspaceId, workspaceMembers.workspaceId))
    .where(eq(workspaceMembers.userId, user.userId))
    .orderBy(asc(workspaceMembers.joinedAt))
}

export async function listThemesForExport(user: UserScope) {
  return useDatabase().select().from(themes).where(eq(themes.userId, user.userId)).orderBy(asc(themes.createdAt))
}

export async function listAiSessionsForExport(user: UserScope) {
  return useDatabase().select().from(aiSessions).where(eq(aiSessions.initiatorUserId, user.userId)).orderBy(asc(aiSessions.startedAt))
}

export async function listAiMessagesForExport(user: UserScope) {
  return useDatabase().select().from(aiSessionMessages).where(eq(aiSessionMessages.userId, user.userId)).orderBy(asc(aiSessionMessages.createdAt))
}

export async function listActivityForExport(user: UserScope) {
  return useDatabase().select().from(activityLog).where(eq(activityLog.userId, user.userId)).orderBy(asc(activityLog.createdAt))
}

/** Audit rows the user acted in, or that are about their account (`scope = 'user'`, their id). */
export async function listAuditForExport(user: UserScope) {
  return useDatabase().select().from(auditLog)
    .where(sql`(${auditLog.actorUserId} = ${user.userId} OR (${auditLog.scope} = 'user' AND ${auditLog.scopeId} = ${String(user.userId)}))`)
    .orderBy(asc(auditLog.ts))
}

export async function listConsentForExport(user: UserScope) {
  return useDatabase().select().from(consentLog).where(eq(consentLog.userId, user.userId)).orderBy(asc(consentLog.createdAt))
}

/** Reports the user filed signed in: their fields and the decision as sent, never moderator notes or identity. */
export async function listFiledAbuseReports(user: UserScope) {
  return useDatabase()
    .select({
      reportId: abuseReports.reportId,
      contentUrl: abuseReports.contentUrl,
      docId: abuseReports.docId,
      category: abuseReports.category,
      body: abuseReports.body,
      reporterName: abuseReports.reporterName,
      reporterEmail: abuseReports.reporterEmail,
      reporterLocale: abuseReports.reporterLocale,
      reporterIpTruncated: abuseReports.reporterIpTruncated,
      goodFaithConfirmedAt: abuseReports.goodFaithConfirmedAt,
      status: abuseReports.status,
      decisionAction: abuseReports.decisionAction,
      decisionRule: abuseReports.decisionRule,
      decisionExplanation: abuseReports.decisionExplanation,
      createdAt: abuseReports.createdAt,
      acknowledgedAt: abuseReports.acknowledgedAt,
      actionedAt: abuseReports.actionedAt
    })
    .from(abuseReports)
    .where(eq(abuseReports.reporterUserId, user.userId))
    .orderBy(asc(abuseReports.createdAt))
}

const noticeColumns = {
  reportId: moderationNotices.reportId,
  kind: moderationNotices.kind,
  status: moderationNotices.status,
  locale: moderationNotices.locale,
  subject: moderationNotices.subject,
  body: moderationNotices.body,
  createdAt: moderationNotices.createdAt
}

/** Notices sent to the user as the reporter of their own reports. */
export async function listReporterNoticesForExport(user: UserScope, reportIds: readonly string[]) {
  if (reportIds.length === 0) return []
  return useDatabase().select(noticeColumns).from(moderationNotices)
    .innerJoin(abuseReports, eq(abuseReports.reportId, moderationNotices.reportId))
    .where(and(
      inArray(moderationNotices.reportId, [...reportIds]),
      eq(moderationNotices.recipientRole, 'reporter'),
      eq(abuseReports.reporterUserId, user.userId)
    ))
    .orderBy(asc(moderationNotices.createdAt))
}

/** Statements of reasons the user received as a document owner. */
export async function listOwnerNoticesForExport(user: UserScope) {
  return useDatabase().select(noticeColumns).from(moderationNotices)
    .where(and(eq(moderationNotices.recipientUserId, user.userId), eq(moderationNotices.recipientRole, 'owner')))
    .orderBy(asc(moderationNotices.createdAt))
}

export async function listSsoIdentitiesForExport(user: UserScope) {
  return useDatabase().select({
    workspaceId: ssoConnections.workspaceId,
    protocol: ssoConnections.protocol,
    subject: userIdentities.subject,
    active: userIdentities.active,
    createdAt: userIdentities.createdAt,
    lastLoginAt: userIdentities.lastLoginAt
  }).from(userIdentities)
    .innerJoin(ssoConnections, eq(ssoConnections.id, userIdentities.connectionId))
    .where(eq(userIdentities.userId, user.userId))
}

/** Documents shared with the user as a guest, and the shares the user granted. */
export async function listDocumentSharesForExport(user: UserScope) {
  const db = useDatabase()
  const cols = {
    docId: documentShares.docId,
    title: documents.title,
    workspaceId: documents.workspaceId,
    userId: documentShares.userId,
    access: documentShares.access,
    grantedByUserId: documentShares.grantedByUserId,
    createdAt: documentShares.createdAt
  }
  const [received, granted] = await Promise.all([
    db.select(cols).from(documentShares).innerJoin(documents, eq(documents.docId, documentShares.docId)).where(eq(documentShares.userId, user.userId)),
    db.select(cols).from(documentShares).innerJoin(documents, eq(documents.docId, documentShares.docId)).where(eq(documentShares.grantedByUserId, user.userId))
  ])
  return { received, granted }
}

export async function listBrandAssetsUploadedBy(user: UserScope) {
  return useDatabase().select({
    workspaceId: workspaceBrandAssets.workspaceId,
    kind: workspaceBrandAssets.kind,
    name: workspaceBrandAssets.name,
    weight: workspaceBrandAssets.weight,
    style: workspaceBrandAssets.style,
    format: workspaceBrandAssets.format,
    createdAt: workspaceBrandAssets.createdAt
  }).from(workspaceBrandAssets).where(eq(workspaceBrandAssets.uploadedBy, user.userId))
}
