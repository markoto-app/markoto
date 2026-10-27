import { nanoid } from 'nanoid'
// `createError` is Nuxt-auto-imported in production but the repos test
// tier runs outside Nuxt's runtime, so we import it explicitly. The
// runtime auto-import gracefully shadows this symbol when both are
// in scope (no double-shape risk — h3's createError is a singleton).
import { createError } from 'h3'
import { createDoc, type CreateDocInput } from '../repos/documents'
import { getWorkspace } from '../repos/workspaces'
import { getThemeById } from '../repos/themes'
import { getWorkspaceRole } from './workspaceAccess'
import { isAudienceKind, type AudienceKind } from '~~/shared/audiences'
import { LANGUAGE_MAX_LENGTH } from '~~/shared/languages'
import { THEME_PRESETS } from '~~/shared/utils/themePresets'
import { isTemplateId } from '~~/shared/templates'
import type { DocTheme } from '~~/shared/types/theme'
import { adaptCustomCssToDoc } from '~~/shared/utils/customCss'
import { themeImagesForDoc } from '~~/shared/utils/themeImages'

// Document creation — single source of truth shared by:
//   - `POST /api/docs` (the user-facing endpoint)
//   - `handleCreateDocument` AI-tool handler (in-app loop + MCP)
//
// The HTTP endpoint used to inline all of this; factored out so the
// tool handler doesn't drift on validation rules (which audience values
// are valid, theme-resolution precedence, workspace-role gating).
//
// Anonymous creation is allowed when ownerId is null — produces an
// `open-edit` doc with no workspace and no saved-theme access. The
// agentic-loop callers ALWAYS pass a numeric ownerId (the initiator's
// real userId), so the anonymous branch is exercised only by the HTTP
// endpoint's `getValidatedUserSession` returning null.

export const TITLE_MAX_LENGTH = 255
export const DESCRIPTION_MAX_LENGTH = 500

export interface CreateDocumentParams {
  /** Real human user id, or null for anonymous creation. Tool handlers
   *  ALWAYS pass a non-null id (initiatorUserId from the ToolContext). */
  ownerId: number | null
  /** Free-form title, ≤255 chars after trimming. Falls back to the
   *  default 'Untitled' when omitted or empty. */
  title?: string
  description?: string
  audience?: AudienceKind
  language?: string
  templateId?: string
  /** Mutually exclusive with `themeId`. Must be a key in `THEME_PRESETS`. */
  themePreset?: string
  /** Mutually exclusive with `themePreset`. Must belong to `ownerId` —
   *  cross-user theme application is rejected. */
  themeId?: string
  /** Optional workspace assignment. Caller must be admin or editor of
   *  the workspace; viewers and non-members are rejected. Anonymous
   *  creators (ownerId=null) cannot file into a workspace at all. */
  workspaceId?: string | null
}

export interface CreateDocumentResult {
  /** Newly minted nanoid (10 chars) — also the URL slug at /d/{docId}. */
  docId: string
  /** Convenience for tool handlers — saves the model from manually
   *  concatenating /d/<docId>. */
  url: string
}

/**
 * Validate every input field, resolve workspace + theme, insert the
 * documents row. Throws `createError(...)` on validation failure with
 * the same status codes the original endpoint used (400 / 401 / 403 /
 * 404), so HTTP callers + tool callers (which surface the error message
 * via the framework-level error handler / tool-result `isError`) get
 * consistent responses.
 *
 * Theme precedence (first match wins):
 *   1. `themeId`     — caller's own saved-theme preset
 *   2. `themePreset` — built-in preset id
 *   3. Workspace default theme (when filing into a workspace)
 *   4. Schema default — applied by `createDoc()` when none of above set.
 *
 * `themeId` + `themePreset` are mutex'd — passing both fails fast rather
 * than silently letting (1) win, so callers can't smuggle a built-in id
 * past a theme whitelist by also sending a saved id.
 */
export async function createDocument(input: CreateDocumentParams): Promise<CreateDocumentResult> {
  const docId = nanoid(10)
  const workspaceId = await resolveWorkspace(input.workspaceId, input.ownerId)

  const create: CreateDocInput = {
    docId,
    ownerId: input.ownerId,
    workspaceId,
    accessMode: input.ownerId == null ? 'open-edit' : 'private'
  }

  const title = parseTitle(input.title)
  if (title !== null) create.title = title

  const description = parseDescription(input.description)
  if (description !== null) create.description = description

  if (input.audience !== undefined) {
    if (!isAudienceKind(input.audience)) {
      throw createError({ statusCode: 400, message: 'Invalid audience' })
    }
    create.audience = input.audience
  }

  const language = parseLanguage(input.language)
  if (language !== null) create.language = language

  if (input.templateId !== undefined) {
    if (!isTemplateId(input.templateId)) {
      throw createError({ statusCode: 400, message: 'Unknown templateId' })
    }
    create.templateId = input.templateId
  }

  const theme = await resolveTheme(input, input.ownerId, workspaceId)
  if (theme !== null) create.theme = withCustomCssForNewDoc(theme, docId)

  await createDoc(create)
  return { docId, url: `/d/${docId}` }
}

/**
 * A saved theme / workspace default may carry custom CSS and theme
 * images that point at the uploads of the document it was made in. A
 * brand-new doc has no uploads, so those rules / image URLs are dropped
 * here (the render-time checks would ignore them anyway — this keeps the
 * stored theme honest).
 */
function withCustomCssForNewDoc(theme: DocTheme, docId: string): DocTheme {
  const images = themeImagesForDoc(theme, docId).theme
  const adapted = adaptCustomCssToDoc(images.customCss, { docId })
  return adapted.dropped.length === 0 ? images : { ...images, customCss: adapted.css }
}

async function resolveWorkspace(raw: string | null | undefined, ownerId: number | null): Promise<string | null> {
  if (raw === undefined || raw === null || raw.length === 0) return null
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

function parseTitle(raw: string | undefined): string | null {
  if (raw === undefined) return null
  const trimmed = raw.trim()
  if (trimmed.length > TITLE_MAX_LENGTH) {
    throw createError({ statusCode: 400, message: 'Title too long' })
  }
  return trimmed.length > 0 ? trimmed : null
}

function parseDescription(raw: string | undefined): string | null {
  if (raw === undefined) return null
  if (raw.length > DESCRIPTION_MAX_LENGTH) {
    throw createError({ statusCode: 400, message: `Description too long (max ${DESCRIPTION_MAX_LENGTH})` })
  }
  return raw.trim()
}

function parseLanguage(raw: string | undefined): string | null {
  if (raw === undefined) return null
  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    throw createError({ statusCode: 400, message: 'Language cannot be empty' })
  }
  if (trimmed.length > LANGUAGE_MAX_LENGTH) {
    throw createError({ statusCode: 400, message: 'Language too long' })
  }
  return trimmed
}

async function resolveTheme(
  input: CreateDocumentParams,
  ownerId: number | null,
  workspaceId: string | null
): Promise<DocTheme | null> {
  if (input.themeId !== undefined && input.themePreset !== undefined) {
    throw createError({ statusCode: 400, message: 'Pass themeId OR themePreset, not both' })
  }
  if (input.themeId !== undefined) {
    if (ownerId == null) {
      throw createError({ statusCode: 401, message: 'Login required to use saved themes' })
    }
    const saved = await getThemeById(input.themeId, ownerId)
    if (!saved) {
      throw createError({ statusCode: 404, message: 'Saved theme not found' })
    }
    return saved.theme
  }
  if (input.themePreset !== undefined) {
    const preset = THEME_PRESETS.find(p => p.id === input.themePreset)
    if (!preset) {
      throw createError({ statusCode: 400, message: 'Unknown themePreset' })
    }
    return preset.theme
  }
  if (workspaceId !== null) {
    const ws = await getWorkspace(workspaceId)
    return ws?.defaultTheme ?? null
  }
  return null
}
