import { DeleteObjectCommand } from '@aws-sdk/client-s3'
import * as Sentry from '@sentry/nuxt'
import { getKnowledge, deleteKnowledgeRow } from '../../repos/knowledge'
import { useEnv } from '~~/shared/env/load'
import { useLogger } from '../platform/logger'
import type { WorkspaceAccess } from '../../repos/proofs'

const log = useLogger('knowledge')

/**
 * Knowledge-base access rules (declared by the routes under
 * server/api/workspaces/[wsId]/knowledge/):
 *
 *   - View: any workspace member.
 *   - Upload: admin or editor.
 *   - Delete: admin, or editor who uploaded the file. Viewers never.
 *
 * Shared knowledge is the whole point: editors curate without bugging an
 * admin, but may not delete each other's uploads; admins override.
 */

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
export async function deleteKnowledgeArtifact(ws: WorkspaceAccess<'editor'>, knowledgeId: string): Promise<void> {
  const row = await getKnowledge(ws, knowledgeId)
  if (!row) return

  await deleteKnowledgeRow(ws, knowledgeId)

  const env = useEnv()
  const s3 = useS3Client()
  try {
    await s3.send(new DeleteObjectCommand({
      Bucket: env.storage.bucket,
      Key: row.s3Key
    }))
  } catch (e) {
    log.error('S3 delete failed', { s3Key: row.s3Key, err: e })
    Sentry.captureException(e, {
      tags: { component: 'knowledgeAccess', event: 's3_delete_failed', knowledgeId }
    })
  }
}
