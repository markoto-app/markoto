import { moveDocumentToWorkspace } from '../../../utils/documents/workspaceMove'
import { moveDocWorkspaceBody } from '~~/shared/api/sharing'

// Move a document into, between, or out of a workspace.
//
// Body: { workspaceId: string | null }
//   - string: move into that workspace (user must be admin or editor there)
//   - null:   detach from any workspace (back to "personal")
//
// Authz:
//   - `manage` on the source (owner or current workspace admin). Editors
//     of the current workspace intentionally can't move a doc, that's a
//     sharing change, not a content edit.
//   - When targeting a workspace, actor must be admin OR editor of it
//     (creation-grade grant). Viewers can't pull docs into their own
//     view-only workspaces.
// The move itself (shares, templates, folder, audit): utils/documents/workspaceMove.ts.
export default defineApiHandler({
  access: allow.doc('manage', { deny: 'share/move-not-allowed' }),
  body: moveDocWorkspaceBody,
  handler: async ({ event, prove, doc, docAccess, body: { workspaceId: target } }) => {
    await moveDocumentToWorkspace(docAccess, doc.workspaceId, target, { prove, actorIp: getClientIp(event) })
    return { success: true, workspaceId: target }
  }
})
