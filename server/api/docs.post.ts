import { nanoid } from 'nanoid'
import { createDoc } from '../repos/documents'
import { getWorkspace } from '../repos/workspaces'
import { getThemeById } from '../repos/themes'
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
    // NEW: id of a user-saved theme (one of the caller's own).
    // Mutually exclusive with `themePreset`. Resolved to a full theme
    // server-side after ownership check, so the client only ships an
    // id (no surface for arbitrary CSS injection via the JSONB column).
    themeId?: unknown
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

  // Theme resolution order (first match wins):
  //   1. `themeId`     — caller's own saved-theme preset
  //   2. `themePreset` — built-in preset id
  //   3. Workspace default theme (when filing into a workspace)
  //   4. Schema default (markoto preset, applied by createDoc)
  //
  // Client only ships ids; the full theme JSONB is resolved here so
  // there's no surface for arbitrary CSS injection. (1) and (2) are
  // mutually exclusive — passing both fails fast rather than silently
  // letting (1) win, so callers can't smuggle a built-in id past a
  // theme whitelist by also sending a saved id.
  if (body.themeId !== undefined && body.themePreset !== undefined) {
    throw createError({ statusCode: 400, message: 'Pass themeId OR themePreset, not both' })
  }
  if (body.themeId !== undefined) {
    if (typeof body.themeId !== 'string') throw createError({ statusCode: 400, message: 'themeId must be a string' })
    if (ownerId == null) throw createError({ statusCode: 401, message: 'Login required to use saved themes' })
    const saved = await getThemeById(body.themeId, ownerId)
    if (!saved) throw createError({ statusCode: 404, message: 'Saved theme not found' })
    create.theme = saved.theme
  } else if (body.themePreset !== undefined) {
    if (typeof body.themePreset !== 'string') throw createError({ statusCode: 400, message: 'themePreset must be a string' })
    const preset = THEME_PRESETS.find(p => p.id === body.themePreset)
    if (!preset) throw createError({ statusCode: 400, message: 'Unknown themePreset' })
    create.theme = preset.theme
  } else if (workspaceId !== null) {
    // No client-supplied theme — fall back to the workspace's default
    // (snapshot at creation time, so future changes to the workspace
    // default don't ripple into already-created docs).
    const ws = await getWorkspace(workspaceId)
    if (ws?.defaultTheme) create.theme = ws.defaultTheme
  }

  await createDoc(create)

  return { docId }
})
