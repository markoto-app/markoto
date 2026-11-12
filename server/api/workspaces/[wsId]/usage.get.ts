import { listWorkspaceUsage } from '../../../repos/workspaceUsage'
import { openMemberKey, readMemberKeySpend } from '../../../utils/litellm/workspaceTeams'
import { getPooledWorkspace } from '../../../utils/billing/workspaceBilling'

// GET /api/workspaces/:wsId/usage — per-person usage of the workspace for
// its admins: documents they own in it, knowledge files and image
// storage they added to it, and — in a paid Team / Business workspace —
// their AI spend this budget period on the shared budget. Guests are
// listed (documents shared with them), never with AI spend (they use
// their own budget). No activity times: this is usage, not monitoring.
export default defineApiHandler({
  access: allow.workspace('admin', { deny: 'usage/admin-required' }),
  handler: async ({ event, wsId, workspaceAccess }) => {
    const rows = await listWorkspaceUsage(workspaceAccess)

    const pooled = await getPooledWorkspace(wsId)
    const members = await Promise.all(rows.map(async (r) => {
      let aiSpendUsd: number | null = null
      if (pooled && r.role !== 'guest') {
        try {
          aiSpendUsd = r.keyToken ? (await readMemberKeySpend(openMemberKey(wsId, r.userId, r.keyToken)))?.spend ?? 0 : 0
        } catch {
          aiSpendUsd = null
        }
      }
      return {
        userId: r.userId,
        name: r.name,
        role: r.role,
        documents: r.docs,
        sharedDocuments: r.sharedDocs,
        knowledgeFiles: r.knowledgeFiles,
        knowledgeBytes: r.knowledgeBytes,
        imageBytes: r.imageBytes,
        aiSpendUsd
      }
    }))
    setHeader(event, 'cache-control', 'private, no-store')
    return { aiBudgetShared: pooled !== null, members }
  }
})
