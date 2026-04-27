import { nanoid } from 'nanoid'
import { createDoc } from '../repos/documents'
import { isAudienceKind } from '~~/shared/audiences'
import { LANGUAGE_MAX_LENGTH } from '~~/shared/languages'
import { THEME_PRESETS } from '~~/shared/utils/themePresets'
import { isTemplateId } from '~~/shared/templates'

const DESCRIPTION_MAX_LENGTH = 500
const TITLE_MAX_LENGTH = 255

export default defineEventHandler(async (event) => {
  // `getValidatedUserSession` cross-checks the DB and clears stale cookies.
  // Anonymous creation is allowed — ownerId falls back to null.
  const session = await getValidatedUserSession(event)
  const docId = nanoid(10)
  const ownerId = session?.user?.id ?? null

  // Optional workspace assignment. Honoured for logged-in admins and editors
  // of the target workspace. Viewers cannot create docs (no write grant in
  // the workspace). Anonymous callers can never file into a workspace.
  // Post-creation moves live at PATCH /api/docs/:docId/workspace.
  const body: {
    workspaceId?: unknown
    title?: unknown
    description?: unknown
    audience?: unknown
    language?: unknown
    templateId?: unknown
    themePreset?: unknown
  } = await readBody(event).catch(() => ({}))
  let workspaceId: string | null = null
  if (typeof body?.workspaceId === 'string' && body.workspaceId.length > 0) {
    if (ownerId == null) {
      throw createError({ statusCode: 401, message: 'Login required to use workspaces' })
    }
    const role = await getWorkspaceRole(ownerId, body.workspaceId)
    if (role === null) {
      throw createError({ statusCode: 403, message: 'Not a member of this workspace' })
    }
    if (role === 'viewer') {
      throw createError({ statusCode: 403, message: 'Viewers cannot create documents' })
    }
    workspaceId = body.workspaceId
  }

  // Optional dialog fields. Each validates independently so the
  // "Just give me a blank doc" path (empty body) stays valid.
  const create: Parameters<typeof createDoc>[0] = {
    docId,
    ownerId,
    workspaceId,
    accessMode: ownerId != null ? 'private' : 'open-edit'
  }

  if (body.title !== undefined) {
    if (typeof body.title !== 'string') throw createError({ statusCode: 400, message: 'Title must be a string' })
    const trimmed = body.title.trim()
    if (trimmed.length > TITLE_MAX_LENGTH) throw createError({ statusCode: 400, message: 'Title too long' })
    if (trimmed.length > 0) create.title = trimmed
  }

  if (body.description !== undefined) {
    if (typeof body.description !== 'string') throw createError({ statusCode: 400, message: 'Description must be a string' })
    if (body.description.length > DESCRIPTION_MAX_LENGTH) {
      throw createError({ statusCode: 400, message: `Description too long (max ${DESCRIPTION_MAX_LENGTH})` })
    }
    create.description = body.description.trim()
  }

  if (body.audience !== undefined) {
    if (!isAudienceKind(body.audience)) throw createError({ statusCode: 400, message: 'Invalid audience' })
    create.audience = body.audience
  }

  if (body.language !== undefined) {
    if (typeof body.language !== 'string') throw createError({ statusCode: 400, message: 'Language must be a string' })
    const trimmed = body.language.trim()
    if (trimmed.length === 0) throw createError({ statusCode: 400, message: 'Language cannot be empty' })
    if (trimmed.length > LANGUAGE_MAX_LENGTH) throw createError({ statusCode: 400, message: 'Language too long' })
    create.language = trimmed
  }

  if (body.templateId !== undefined) {
    if (!isTemplateId(body.templateId)) throw createError({ statusCode: 400, message: 'Unknown templateId' })
    create.templateId = body.templateId
  }

  // Theme preset = the id of one of the built-in presets. Resolved to
  // the full theme object server-side so the client only ships an id —
  // no surface for an attacker to inject arbitrary CSS via the theme
  // JSONB column at creation time.
  if (body.themePreset !== undefined) {
    if (typeof body.themePreset !== 'string') throw createError({ statusCode: 400, message: 'themePreset must be a string' })
    const preset = THEME_PRESETS.find(p => p.id === body.themePreset)
    if (!preset) throw createError({ statusCode: 400, message: 'Unknown themePreset' })
    create.theme = preset.theme
  }

  await createDoc(create)

  return { docId }
})
