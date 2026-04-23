import { DeleteObjectCommand } from '@aws-sdk/client-s3'
import * as Sentry from '@sentry/nuxt'
import type { H3Event } from 'h3'
import { getMemberRole } from '../repos/workspaceMembers'
import { getKnowledge, deleteKnowledgeRow } from '../repos/knowledge'
import type { WorkspaceRole } from '../../shared/utils/docPermissions'

/**
 * Knowledge-base access rules:
 *
 *   - View (list / download via AI tool): any workspace member.
 *   - Upload / rename: admin or editor.
 *   - Delete: admin, or editor who uploaded the file. Viewers never.
 *
 * Rationale: shared knowledge is the whole point. We want editors to
 * curate without bugging an admin. Allowing editors to delete each
 * other's uploads would be easy to abuse, so we scope editor-delete to
 * their own uploads; admins override.
 */

export async function requireKnowledgeViewAccess(
  event: H3Event,
  workspaceId: string,
  userId: number
): Promise<WorkspaceRole> {
  const role = await getMemberRole(workspaceId, userId)
  if (!role) {
    // 404 (not 403) so we never leak existence of a workspace the
    // caller doesn't belong to.
    throw createError({ statusCode: 404, message: 'Workspace not found' })
  }
  return role
}

export async function requireKnowledgeEditAccess(
  event: H3Event,
  workspaceId: string,
  userId: number
): Promise<WorkspaceRole> {
  const role = await requireKnowledgeViewAccess(event, workspaceId, userId)
  if (role === 'viewer') {
    throw createError({ statusCode: 403, message: 'Only admins and editors can modify knowledge' })
  }
  return role
}

export async function requireKnowledgeDeleteAccess(
  event: H3Event,
  workspaceId: string,
  userId: number,
  uploaderId: number | null
): Promise<WorkspaceRole> {
  const role = await requireKnowledgeEditAccess(event, workspaceId, userId)
  if (role === 'admin') return role
  // Editor: only their own uploads. Anonymous/NULL uploader can only be
  // cleaned up by an admin.
  if (uploaderId !== null && uploaderId === userId) return role
  throw createError({ statusCode: 403, message: 'Editors can only delete their own uploads' })
}

/**
 * Full-cascade delete: S3 object + DB row. Chunks cascade with the row
 * via FK. Caller is responsible for the authorization check — we just
 * clean up the artifacts.
 *
 * Ordering: DB row first (so the file "disappears" from the user's
 * perspective immediately), then S3. An S3 failure is reported to
 * Sentry but does not throw — the object will be orphaned but the
 * user sees a successful delete.
 */
export async function deleteKnowledgeArtifact(knowledgeId: string): Promise<void> {
  const row = await getKnowledge(knowledgeId)
  if (!row) return

  await deleteKnowledgeRow(knowledgeId)

  const config = useRuntimeConfig()
  const s3 = useS3Client()
  try {
    await s3.send(new DeleteObjectCommand({
      Bucket: config.s3.bucket,
      Key: row.s3Key
    }))
  } catch (e) {
    console.error(`[knowledge] S3 delete failed for ${row.s3Key}:`, e instanceof Error ? e.message : e)
    Sentry.captureException(e, {
      tags: { component: 'knowledgeAccess', event: 's3_delete_failed', knowledgeId }
    })
  }
}
