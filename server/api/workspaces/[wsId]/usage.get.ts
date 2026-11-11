import { sql } from 'drizzle-orm'
import { useDatabase } from '../../../utils/platform/database'
import { decryptToken } from '../../../utils/litellm/tokenCrypto'
import { readMemberKeySpend } from '../../../utils/litellm/workspaceTeams'
import { getPooledWorkspace } from '../../../utils/billing/workspaceBilling'

// GET /api/workspaces/:wsId/usage — per-person usage of the workspace for
// its admins: documents they own in it, knowledge files and image
// storage they added to it, and — in a paid Team / Business workspace —
// their AI spend this budget period on the shared budget. Guests are
// listed (documents shared with them), never with AI spend (they use
// their own budget). No activity times: this is usage, not monitoring.
export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const wsId = requireWsId(event)
  const role = await getWorkspaceRole(session.user.id, wsId)
  if (role === null) throw createError({ statusCode: 404, message: 'Workspace not found' })
  if (role !== 'admin') throw createError({ statusCode: 403, message: 'Only workspace admins can see usage.', data: { code: 'usage/admin-required' } })

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

  const pooled = await getPooledWorkspace(wsId)
  const members = await Promise.all(rows.map(async (r) => {
    let aiSpendUsd: number | null = null
    if (pooled && r.role !== 'guest') {
      try {
        aiSpendUsd = r.key_token ? (await readMemberKeySpend(decryptToken(r.key_token)))?.spend ?? 0 : 0
      } catch {
        aiSpendUsd = null
      }
    }
    return {
      userId: Number(r.user_id),
      name: r.name,
      role: r.role,
      documents: Number(r.docs),
      sharedDocuments: Number(r.shared_docs),
      knowledgeFiles: Number(r.knowledge_files),
      knowledgeBytes: Number(r.knowledge_bytes),
      imageBytes: Number(r.image_bytes),
      aiSpendUsd
    }
  }))
  setHeader(event, 'cache-control', 'private, no-store')
  return { aiBudgetShared: pooled !== null, members }
})
