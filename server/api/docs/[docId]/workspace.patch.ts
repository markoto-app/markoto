import { moveDocToWorkspace } from '../../../repos/documents'

// Move a document into, between, or out of a workspace.
//
// Body: { workspaceId: string | null }
//   - string: move into that workspace (user must be admin or editor there)
//   - null:   detach from any workspace (back to "personal")
//
// Authz:
//   - Actor must pass canManageDoc on the source (owner or current
//     workspace admin). Editors of the current workspace intentionally
//     can't move a doc — that's a sharing change, not a content edit.
//   - When targeting a workspace, actor must be admin OR editor of it
//     (creation-grade grant). Viewers can't pull docs into their own
//     view-only workspaces.
export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const docId = requireDocId(event)
  // `readBody` returns undefined (not throws) for an empty body — coerce
  // to `{}` so the `in` check below doesn't explode on a missing body.
  const body = ((await readBody(event).catch(() => null)) ?? {}) as {
    workspaceId?: unknown
  }

  if (!('workspaceId' in body)) {
    throw createError({ statusCode: 400, message: 'workspaceId is required (string or null)' })
  }
  const rawTarget = body.workspaceId
  if (rawTarget !== null && (typeof rawTarget !== 'string' || rawTarget.length === 0)) {
    throw createError({ statusCode: 400, message: 'workspaceId must be a non-empty string or null' })
  }
  // After the guard: rawTarget is `string | null`. `workspaceId: undefined`
  // — which hits the `in` check if someone serialized it explicitly —
  // fails the typeof string branch and is rejected as 400.
  const target: string | null = rawTarget as string | null

  const authz = await getDocAuthz(session.user.id, docId)
  if (!authz.exists) {
    throw createError({ statusCode: 404, message: 'Document not found' })
  }
  if (!authz.canManage) {
    throw createError({ statusCode: 403, message: 'Only the owner or a workspace admin can move this document' })
  }

  if (target !== null) {
    const targetRole = await getWorkspaceRole(session.user.id, target)
    if (targetRole === null) {
      throw createError({ statusCode: 403, message: 'Not a member of the target workspace' })
    }
    if (targetRole === 'viewer') {
      throw createError({ statusCode: 403, message: 'Viewers cannot receive documents into a workspace' })
    }
  }

  // No-op if nothing would change — saves a write and keeps lastActive
  // stable when the client posts a redundant patch.
  if (authz.workspaceId === target) {
    return { success: true, workspaceId: target }
  }

  await moveDocToWorkspace(docId, target)
  return { success: true, workspaceId: target }
})
