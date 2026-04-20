import { nanoid } from 'nanoid'
import { workspaces, workspaceMembers } from '../../db/schema'

export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const body = await readBody<{ name?: unknown, description?: unknown }>(event)

  const rawName = typeof body?.name === 'string' ? body.name.trim() : ''
  if (!rawName) throw createError({ statusCode: 400, message: 'Name is required' })
  if (rawName.length > 255) throw createError({ statusCode: 400, message: 'Name too long (max 255)' })

  let description: string | null = null
  if (body?.description !== undefined && body.description !== null) {
    if (typeof body.description !== 'string') {
      throw createError({ statusCode: 400, message: 'Description must be a string' })
    }
    const trimmed = body.description.trim()
    if (trimmed.length > 1024) {
      throw createError({ statusCode: 400, message: 'Description too long (max 1024)' })
    }
    description = trimmed.length > 0 ? trimmed : null
  }

  const workspaceId = nanoid(10)
  const db = useDatabase()

  // Creator gets a workspace row (for the immutable ownerId record) and a
  // workspace_members row with role='admin'. Membership table is the source
  // of truth for authorization; workspaces.ownerId is for history only.
  await db.insert(workspaces).values({
    workspaceId,
    ownerId: session.user.id,
    name: rawName,
    description
  })
  await db.insert(workspaceMembers).values({
    workspaceId,
    userId: session.user.id,
    role: 'admin'
  })

  return { workspaceId }
})
