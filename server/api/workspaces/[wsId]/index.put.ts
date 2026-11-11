import { updateWorkspace, type WorkspaceUpdate } from '../../../repos/workspaces'
import { updateWorkspaceBody } from '~~/shared/api/workspaces'

// Rename / edit workspace. Admins only — editors and viewers can't change
// the workspace's identity. The "is the workspace still there at all"
// check is implicit in the role lookup (no role => 404).
export default defineApiHandler({
  access: allow.workspace('admin', { deny: 'workspace/admin-required' }),
  body: updateWorkspaceBody,
  handler: async ({ event, wsId, body }) => {
    const updates: WorkspaceUpdate = {}
    if (body?.name !== undefined) updates.name = body.name
    if (body?.description !== undefined) updates.description = body.description
    // `null` clears the default (revert to the global markoto preset). The
    // schema is the one that gates per-document theme writes, so anything
    // valid in a document is valid here.
    if (body?.defaultTheme !== undefined) updates.defaultTheme = body.defaultTheme
    // No document context — see `assertValidThemeCustomCss`.
    assertValidThemeCustomCss(body?.defaultTheme, null, event)

    await updateWorkspace(wsId, updates)
    return { success: true }
  }
})
