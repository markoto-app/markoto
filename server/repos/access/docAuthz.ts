import { and, eq, or, sql } from 'drizzle-orm'
import type { DocTheme } from '~~/shared/types/theme'
import type { AudienceKind } from '~~/shared/audiences'
import { documentShares, documents, workspaceMembers } from '../../db/schema'
import { ssoEnforcedSql, ssoSatisfiedSql } from '../sso'
import type { WorkspaceRole } from '../../../shared/utils/documents/docPermissions'
import type { AccessMode } from '../documents'
import { useDatabase } from '../../db/client'

// Access bootstrap: the one lookup every document access decision starts
// from. It takes a bare id because it runs BEFORE anything is proven; only
// the access layer (server/utils/access/**) may import it, and it turns the
// row into a decision and a proof.

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
   * longer a member: e.g. deactivated / deleted via SCIM). Ownership of
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
      // guest row is not a member role, guests are outside the IdP).
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
            // in a workspace that enforces it, same as getMemberRole.
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

/** The workspace a document belongs to (null: standalone), or undefined when it does not exist. */
export async function getDocWorkspaceId(docId: string): Promise<string | null | undefined> {
  const row = (await useDatabase().select({ workspaceId: documents.workspaceId }).from(documents).where(eq(documents.docId, docId)).limit(1))[0]
  return row ? row.workspaceId : undefined
}

/**
 * The stored password of a document, for the password check itself (which
 * is how a visitor GAINS access, so it runs before anything is proven).
 */
export async function getDocPasswordForVerify(docId: string): Promise<{ accessMode: AccessMode, passwordHash: string | null } | null> {
  const row = (await useDatabase().select({ accessMode: documents.accessMode, passwordHash: documents.passwordHash })
    .from(documents).where(eq(documents.docId, docId)).limit(1))[0]
  return row ?? null
}
