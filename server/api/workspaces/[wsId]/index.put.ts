import { DocThemeSchema } from '~~/shared/types/theme'
import { updateWorkspace, type WorkspaceUpdate } from '../../../repos/workspaces'

// Rename / edit workspace. Admins only — editors and viewers can't change
// the workspace's identity. The "is the workspace still there at all"
// check is implicit in the role lookup (null role ⇒ 404 below).
export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const wsId = requireWsId(event)
  const body = await readBody<{ name?: unknown, description?: unknown }>(event)

  const role = await getWorkspaceRole(session.user.id, wsId)
  if (role === null) throw createError({ statusCode: 404, message: 'Workspace not found' })
  if (role !== 'admin') {
    throw createError({ statusCode: 403, message: 'Only admins can edit the workspace' })
  }

  const updates: WorkspaceUpdate = {}

  if (body?.name !== undefined) {
    if (typeof body.name !== 'string') throw createError({ statusCode: 400, message: 'Name must be a string' })
    const trimmed = body.name.trim()
    if (!trimmed) throw createError({ statusCode: 400, message: 'Name cannot be empty' })
    if (trimmed.length > 255) throw createError({ statusCode: 400, message: 'Name too long (max 255)' })
    updates.name = trimmed
  }

  if (body?.description !== undefined) {
    if (body.description === null) {
      updates.description = null
    } else {
      if (typeof body.description !== 'string') {
        throw createError({ statusCode: 400, message: 'Description must be a string' })
      }
      const trimmed = body.description.trim()
      if (trimmed.length > 1024) {
        throw createError({ statusCode: 400, message: 'Description too long (max 1024)' })
      }
      updates.description = trimmed.length > 0 ? trimmed : null
    }
  }

  // Workspace default theme — applied to NEW documents created in this
  // workspace. `null` clears it (revert to global markoto default).
  // Theme structure validated against the same schema that gates per-
  // doc theme writes, so anything that's valid in a doc is valid here.
  if (body?.defaultTheme !== undefined) {
    if (body.defaultTheme === null) {
      updates.defaultTheme = null
    } else {
      const parsed = DocThemeSchema.safeParse(body.defaultTheme)
      if (!parsed.success) {
        throw createError({
          statusCode: 400,
          message: 'Invalid defaultTheme payload',
          data: { issues: parsed.error.issues }
        })
      }
      updates.defaultTheme = parsed.data
    }
  }

  await updateWorkspace(wsId, updates)
  return { success: true }
})
