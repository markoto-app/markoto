import { DocThemeSchema, type DocTheme } from '~~/shared/types/theme'
import { updateWorkspace, type WorkspaceUpdate } from '../../../repos/workspaces'

// Rename / edit workspace. Admins only — editors and viewers can't change
// the workspace's identity. The "is the workspace still there at all"
// check is implicit in the role lookup (null role ⇒ 404 below).
export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const wsId = requireWsId(event)
  const body = await readBody<{
    name?: unknown
    description?: unknown
    defaultTheme?: unknown
  }>(event)

  const role = await getWorkspaceRole(session.user.id, wsId)
  if (role === null) throw createError({ statusCode: 404, message: 'Workspace not found' })
  if (role !== 'admin') {
    throw createError({ statusCode: 403, message: 'Only admins can edit the workspace' })
  }

  const updates: WorkspaceUpdate = {}
  const name = parseName(body?.name)
  if (name !== undefined) updates.name = name
  const description = parseDescription(body?.description)
  if (description !== undefined) updates.description = description
  const defaultTheme = parseDefaultTheme(body?.defaultTheme)
  if (defaultTheme !== undefined) updates.defaultTheme = defaultTheme
  // No document context — see `assertValidThemeCustomCss`.
  assertValidThemeCustomCss(defaultTheme, null, event)

  await updateWorkspace(wsId, updates)
  return { success: true }
})

/** Parse the optional `name` field. Returns undefined when absent. */
function parseName(raw: unknown): string | undefined {
  if (raw === undefined) return undefined
  if (typeof raw !== 'string') throw createError({ statusCode: 400, message: 'Name must be a string' })
  const trimmed = raw.trim()
  if (!trimmed) throw createError({ statusCode: 400, message: 'Name cannot be empty' })
  if (trimmed.length > 255) throw createError({ statusCode: 400, message: 'Name too long (max 255)' })
  return trimmed
}

/**
 * Parse the optional `description` field. Returns:
 *  - undefined when absent (no update)
 *  - null when explicitly nulled or empty after trim
 *  - the trimmed string otherwise
 */
function parseDescription(raw: unknown): string | null | undefined {
  if (raw === undefined) return undefined
  if (raw === null) return null
  if (typeof raw !== 'string') {
    throw createError({ statusCode: 400, message: 'Description must be a string' })
  }
  const trimmed = raw.trim()
  if (trimmed.length > 1024) {
    throw createError({ statusCode: 400, message: 'Description too long (max 1024)' })
  }
  return trimmed.length > 0 ? trimmed : null
}

/**
 * Workspace default theme — applied to NEW documents created in this
 * workspace. `null` clears it (revert to global markoto default).
 * Theme structure validated against the same schema that gates per-doc
 * theme writes, so anything that's valid in a doc is valid here.
 *
 * Returns:
 *  - undefined when absent (no update)
 *  - null when explicitly nulled
 *  - the parsed DocTheme otherwise
 */
function parseDefaultTheme(raw: unknown): DocTheme | null | undefined {
  if (raw === undefined) return undefined
  if (raw === null) return null
  const parsed = DocThemeSchema.safeParse(raw)
  if (!parsed.success) {
    throw createError({
      statusCode: 400,
      message: 'Invalid defaultTheme payload',
      data: { issues: parsed.error.issues }
    })
  }
  return parsed.data
}
