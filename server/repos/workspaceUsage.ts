import { sql } from 'drizzle-orm'
import { useDatabase } from '../db/client'
import type { WorkspaceAccess } from './proofs'

// Per-person usage of a workspace for its admins (`GET /api/workspaces/:wsId/usage`):
// documents owned in it, documents shared with a guest, knowledge files and
// image storage added to it. No activity times: usage, not monitoring.

export interface WorkspaceUsageRow {
  userId: number
  name: string
  role: string
  /** The member's LiteLLM key in the workspace team (encrypted), for their AI spend. */
  keyToken: string | null
  docs: number
  sharedDocs: number
  knowledgeFiles: number
  knowledgeBytes: number
  imageBytes: number
}

export async function listWorkspaceUsage(ws: WorkspaceAccess<'admin'>): Promise<WorkspaceUsageRow[]> {
  const wsId = ws.workspaceId
  const rows = (await useDatabase().execute<{
    user_id: number
    name: string
    role: string
    key_token: string | null
    docs: number
    shared_docs: number
    knowledge_files: number
    knowledge_bytes: number
    image_bytes: number
  }>(sql`
    select wm.user_id, u.name, wm.role, wm.litellm_key_token as key_token,
      (select count(*)::int from documents d where d.workspace_id = ${wsId} and d.owner_id = wm.user_id) as docs,
      (select count(*)::int from document_shares s join documents d on d.doc_id = s.doc_id
        where d.workspace_id = ${wsId} and s.user_id = wm.user_id) as shared_docs,
      (select count(*)::int from workspace_knowledge k where k.workspace_id = ${wsId} and k.uploader_id = wm.user_id) as knowledge_files,
      (select coalesce(sum(k.size_bytes), 0)::float8 from workspace_knowledge k where k.workspace_id = ${wsId} and k.uploader_id = wm.user_id) as knowledge_bytes,
      (select coalesce(sum(up.size_bytes), 0)::float8 from uploads up join documents d on d.doc_id = up.doc_id
        where d.workspace_id = ${wsId} and up.uploader_id = wm.user_id) as image_bytes
    from workspace_members wm
    join users u on u.id = wm.user_id
    where wm.workspace_id = ${wsId}
    order by case wm.role when 'admin' then 0 when 'editor' then 1 when 'viewer' then 2 else 3 end, wm.joined_at
  `)).rows
  return rows.map(r => ({
    userId: Number(r.user_id),
    name: r.name,
    role: r.role,
    keyToken: r.key_token,
    docs: Number(r.docs),
    sharedDocs: Number(r.shared_docs),
    knowledgeFiles: Number(r.knowledge_files),
    knowledgeBytes: Number(r.knowledge_bytes),
    imageBytes: Number(r.image_bytes)
  }))
}
