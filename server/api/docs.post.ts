import { nanoid } from 'nanoid'
import { createDoc } from '../repos/documents'
import { getWorkspace } from '../repos/workspaces'
import { getThemeById } from '../repos/themes'
import { isAudienceKind, type AudienceKind } from '~~/shared/audiences'
import { LANGUAGE_MAX_LENGTH } from '~~/shared/languages'
import { THEME_PRESETS } from '~~/shared/utils/themePresets'
import { isTemplateId } from '~~/shared/templates'
import type { DocTheme } from '~~/shared/types/theme'

const DESCRIPTION_MAX_LENGTH = 500
const TITLE_MAX_LENGTH = 255

interface RawBody {
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
}

export default defineEventHandler(async (event) => {
  // `getValidatedUserSession` cross-checks the DB and clears stale cookies.
  // Anonymous creation is allowed — ownerId falls back to null.
  const session = await getValidatedUserSession(event)
  const docId = nanoid(10)
  const ownerId = session?.user?.id ?? null
  const body = await readBody<RawBody>(event).catch((): RawBody => ({}))

  const workspaceId = await resolveWorkspace(body.workspaceId, ownerId)

  // Optional dialog fields. Each validates independently so the
  // "Just give me a blank doc" path (empty body) stays valid.
  const create: Parameters<typeof createDoc>[0] = {
    docId,
    ownerId,
    workspaceId,
    accessMode: ownerId == null ? 'open-edit' : 'private'
  }

  const title = parseTitle(body.title)
  if (title !== null) create.title = title

  const description = parseDescription(body.description)
  if (description !== null) create.description = description

  const audience = parseAudience(body.audience)
  if (audience !== null) create.audience = audience

  const language = parseLanguage(body.language)
  if (language !== null) create.language = language

  const templateId = parseTemplateId(body.templateId)
  if (templateId !== null) create.templateId = templateId

  const theme = await resolveTheme(body, ownerId, workspaceId)
  if (theme !== null) create.theme = theme

  await createDoc(create)
  return { docId }
})

/**
 * Optional workspace assignment. Honoured for logged-in admins and editors
 * of the target workspace. Viewers cannot create docs (no write grant in
 * the workspace). Anonymous callers can never file into a workspace.
 * Post-creation moves live at PATCH /api/docs/:docId/workspace.
 */
async function resolveWorkspace(raw: unknown, ownerId: number | null): Promise<string | null> {
  if (typeof raw !== 'string' || raw.length === 0) return null
  if (ownerId == null) {
    throw createError({ statusCode: 401, message: 'Login required to use workspaces' })
  }
  const role = await getWorkspaceRole(ownerId, raw)
  if (role === null) {
    throw createError({ statusCode: 403, message: 'Not a member of this workspace' })
  }
  if (role === 'viewer') {
    throw createError({ statusCode: 403, message: 'Viewers cannot create documents' })
  }
  return raw
}

function parseTitle(raw: unknown): string | null {
  if (raw === undefined) return null
  if (typeof raw !== 'string') throw createError({ statusCode: 400, message: 'Title must be a string' })
  const trimmed = raw.trim()
  if (trimmed.length > TITLE_MAX_LENGTH) throw createError({ statusCode: 400, message: 'Title too long' })
  return trimmed.length > 0 ? trimmed : null
}

function parseDescription(raw: unknown): string | null {
  if (raw === undefined) return null
  if (typeof raw !== 'string') throw createError({ statusCode: 400, message: 'Description must be a string' })
  if (raw.length > DESCRIPTION_MAX_LENGTH) {
    throw createError({ statusCode: 400, message: `Description too long (max ${DESCRIPTION_MAX_LENGTH})` })
  }
  return raw.trim()
}

function parseAudience(raw: unknown): AudienceKind | null {
  if (raw === undefined) return null
  if (!isAudienceKind(raw)) throw createError({ statusCode: 400, message: 'Invalid audience' })
  return raw
}

function parseLanguage(raw: unknown): string | null {
  if (raw === undefined) return null
  if (typeof raw !== 'string') throw createError({ statusCode: 400, message: 'Language must be a string' })
  const trimmed = raw.trim()
  if (trimmed.length === 0) throw createError({ statusCode: 400, message: 'Language cannot be empty' })
  if (trimmed.length > LANGUAGE_MAX_LENGTH) throw createError({ statusCode: 400, message: 'Language too long' })
  return trimmed
}

function parseTemplateId(raw: unknown): string | null {
  if (raw === undefined) return null
  if (!isTemplateId(raw)) throw createError({ statusCode: 400, message: 'Unknown templateId' })
  return raw
}

/**
 * Theme resolution order (first match wins):
 *   1. `themeId`     — caller's own saved-theme preset
 *   2. `themePreset` — built-in preset id
 *   3. Workspace default theme (when filing into a workspace)
 *   4. Schema default (markoto preset, applied by createDoc) — returns null here
 *
 * Client only ships ids; the full theme JSONB is resolved here so
 * there's no surface for arbitrary CSS injection. (1) and (2) are
 * mutually exclusive — passing both fails fast rather than silently
 * letting (1) win, so callers can't smuggle a built-in id past a
 * theme whitelist by also sending a saved id.
 */
async function resolveTheme(
  body: RawBody,
  ownerId: number | null,
  workspaceId: string | null
): Promise<DocTheme | null> {
  if (body.themeId !== undefined && body.themePreset !== undefined) {
    throw createError({ statusCode: 400, message: 'Pass themeId OR themePreset, not both' })
  }
  if (body.themeId !== undefined) {
    if (typeof body.themeId !== 'string') throw createError({ statusCode: 400, message: 'themeId must be a string' })
    if (ownerId == null) throw createError({ statusCode: 401, message: 'Login required to use saved themes' })
    const saved = await getThemeById(body.themeId, ownerId)
    if (!saved) throw createError({ statusCode: 404, message: 'Saved theme not found' })
    return saved.theme
  }
  if (body.themePreset !== undefined) {
    if (typeof body.themePreset !== 'string') throw createError({ statusCode: 400, message: 'themePreset must be a string' })
    const preset = THEME_PRESETS.find(p => p.id === body.themePreset)
    if (!preset) throw createError({ statusCode: 400, message: 'Unknown themePreset' })
    return preset.theme
  }
  if (workspaceId !== null) {
    // No client-supplied theme — fall back to the workspace's default
    // (snapshot at creation time, so future changes to the workspace
    // default don't ripple into already-created docs).
    const ws = await getWorkspace(workspaceId)
    return ws?.defaultTheme ?? null
  }
  return null
}
