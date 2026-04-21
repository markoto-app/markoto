import { nanoid } from 'nanoid'
import { createWorkspace } from '../../repos/workspaces'

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

  // createWorkspace writes the workspaces row AND the creator's admin
  // membership row in one transaction — neither can land without the
  // other, so the ≥1-admin invariant holds from t=0.
  await createWorkspace({
    workspaceId,
    ownerId: session.user.id,
    name: rawName,
    description
  })

  return { workspaceId }
})
