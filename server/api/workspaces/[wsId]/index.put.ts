import { eq } from 'drizzle-orm'
import { workspaces } from '../../../db/schema'

// Rename / edit workspace. Admins only — editors and viewers can't change
// the workspace's identity. The "is the workspace still there at all"
// check is implicit in the role lookup (null role ⇒ 404 below).
export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const wsId = requireWsId(event)
  const body = await readBody<{ name?: unknown, description?: unknown }>(event)
  const db = useDatabase()

  const role = await getWorkspaceRole(session.user.id, wsId)
  if (role === null) throw createError({ statusCode: 404, message: 'Workspace not found' })
  if (role !== 'admin') {
    throw createError({ statusCode: 403, message: 'Only admins can edit the workspace' })
  }

  const updates: Record<string, unknown> = {}

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

  if (Object.keys(updates).length > 0) {
    await db.update(workspaces).set(updates).where(eq(workspaces.workspaceId, wsId))
  }

  return { success: true }
})
