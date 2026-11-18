import { nanoid } from 'nanoid'
// `createError` is Nuxt-auto-imported in production but the repos test
// tier runs outside Nuxt's runtime, so we import it explicitly. The
// runtime auto-import gracefully shadows this symbol when both are
// in scope (no double-shape risk, h3's createError is a singleton).
import { createError } from 'h3'
import { createDoc, type CreateDocInput } from '../../repos/documents'
import { getWorkspace } from '../../repos/workspaces'
import { getThemeById } from '../../repos/themes'
import { proveWorkspaceAccess } from '../access/workspaceAccess'
import type { UserScope, WorkspaceAccess } from '../../repos/proofs'
import { isAudienceKind, type AudienceKind } from '~~/shared/audiences'
import { LANGUAGE_MAX_LENGTH } from '~~/shared/languages'
import { THEME_PRESETS } from '~~/shared/utils/theme/themePresets'
import { getTemplate, templateCover, type TemplateMeta } from '~~/shared/templates'
import type { DocTheme } from '~~/shared/types/theme'
import { adaptCustomCssToDoc } from '~~/shared/utils/theme/customCss'
import { themeImagesForDoc } from '~~/shared/utils/theme/themeImages'
import { DOC_DESCRIPTION_MAX_LENGTH, DOC_TITLE_MAX_LENGTH, INITIAL_CONTENT_MAX_LENGTH } from '~~/shared/config/docCreate'
import { seedDocContent } from './seedDocContent'
import { indexNewDocument } from './searchIndex'
import { getFolder } from '../../repos/folders'
import { apiError } from '../api/apiError'
import { proveNewDoc } from '../access/docProof'

// Document creation, shared by `POST /api/docs` and the `handleCreateDocument`
// AI-tool handler (in-app loop + MCP) so both apply the same validation
// (audience values, theme precedence, workspace-role gating).
//
// A null ownerId creates an anonymous `open-edit` doc with no workspace and
// no saved-theme access. Agentic-loop callers always pass the initiator's
// real userId, so only the HTTP endpoint can take the anonymous branch.

export interface CreateDocumentParams {
  /** The creating user acting for themselves, or null for anonymous
   *  creation. Tool handlers ALWAYS pass the initiator (`ctx.self`). */
  owner: UserScope | null
  /** Free-form title, ≤255 chars after trimming. Falls back to the
   *  default 'Untitled' when omitted or empty. */
  title?: string
  description?: string
  audience?: AudienceKind
  language?: string
  /** Template (text + design bundle) id or alias. Seeds the body on first
   *  open and, without `themePreset` / `themeId`, sets the template's design. */
  templateId?: string
  /** Mutually exclusive with `themeId`. Must be a key in `THEME_PRESETS`. */
  themePreset?: string
  /** Mutually exclusive with `themePreset`. Must belong to `ownerId`,
   *  cross-user theme application is rejected. */
  themeId?: string
  /** Optional workspace assignment. Caller must be admin or editor of
   *  the workspace; viewers and non-members are rejected. Anonymous
   *  creators (ownerId=null) cannot file into a workspace at all. */
  workspaceId?: string | null
  /** Anonymous creation only (ignored when `ownerId` is set): SHA-256 of
   *  the creating browser's creator key, so only that browser may later
   *  delete the doc (see `server/utils/auth/anonCreator.ts`). */
  anonCreatorKeyHash?: string
  /** Anonymous creation only (ignored when `ownerId` is set): the Terms
   *  acceptance the anonymous gate verified (server/utils/anonGate/). */
  anonTermsAcceptance?: { termsVersion: number, acceptedAt: Date }
  /** Markdown body to start with (≤ `INITIAL_CONTENT_MAX_LENGTH`), written
   *  as the doc's first Y.js update. Mutually exclusive with `templateId`
   *  (a template seeds its body in the browser on first open). */
  content?: string
  /**
   * A design already validated for THIS document (imports: markoto's
   * frontmatter, `server/utils/documents/markdownImport.ts`). Wins over
   * every other source; with `themeId` / `themePreset` it is an error.
   */
  theme?: DocTheme
  /** A pre-chosen id (imports pick ids first so links between imported files can point at them). */
  docId?: string
  /** A longer body limit (imports); default `INITIAL_CONTENT_MAX_LENGTH`. */
  contentMaxLength?: number
  /** The folder to file it in (a folder of the workspace, or of the owner's personal documents). */
  folderId?: string | null
}

export interface CreateDocumentResult {
  /** Newly minted nanoid (10 chars), also the URL slug at /d/{docId}. */
  docId: string
  /** Convenience for tool handlers, saves the model from manually
   *  concatenating /d/<docId>. */
  url: string
}

/**
 * Validate every input field, resolve workspace + theme, insert the
 * documents row. Throws `createError(...)` on validation failure with
 * status codes 400 / 401 / 403 / 404; HTTP and tool callers get the same errors.
 *
 * Theme precedence (first match wins):
 *   0. `theme`: an imported design, validated by the caller
 *   1. `themeId`: caller's own saved-theme preset
 *   2. `themePreset`: built-in preset id
 *   3. The template's design (a template is a text + design bundle;
 *      Blank has none)
 *   4. Workspace default theme (when filing into a workspace)
 *   5. Schema default: applied by `createDoc()` when none of above set.
 *
 * `themeId` + `themePreset` are mutex'd, passing both fails fast rather
 * than silently letting (1) win, so callers can't smuggle a built-in id
 * past a theme whitelist by also sending a saved id.
 */
export async function createDocument(input: CreateDocumentParams): Promise<CreateDocumentResult> {
  const docId = input.docId ?? nanoid(10)
  const ownerId = input.owner?.userId ?? null
  const workspace = await resolveWorkspace(input.workspaceId, input.owner)

  const create: Omit<CreateDocInput, 'ownerId' | 'workspaceId'> = {
    docId,
    accessMode: ownerId == null ? 'open-edit' : 'private'
  }

  const language = applyDocumentProperties(create, input)

  const template = input.templateId === undefined ? null : resolveTemplate(input.templateId)
  // Stored under its current id (an alias like `academic-paper` → `arxiv`).
  if (template !== null) create.templateId = template.id

  const content = parseContent(input.content, input.templateId, input.contentMaxLength ?? INITIAL_CONTENT_MAX_LENGTH)
  const folderId = await resolveFolder(input.folderId, input.owner, workspace)
  if (folderId !== null) create.folderId = folderId

  const resolved = await resolveTheme(input, input.owner, workspace, template)
  if (resolved !== null) {
    // The template's own design gets the template's cover placeholders
    // (authors, affiliations, subtitle), in the document's language.
    const theme = template !== null && resolved.preset !== null && resolved.preset === template.design
      ? withTemplateCover(resolved.theme, template, language ?? 'en')
      : resolved.theme
    create.theme = withCustomCssForNewDoc(theme, docId)
  }

  if (ownerId == null) applyAnonymousCreator(create, input)

  await createDoc(input.owner, workspace, create)
  // Just created: its creator holds every right on it.
  const proof = proveNewDoc(input.owner, docId)
  const yjsId = content !== null ? await seedDocContent(proof, content) : null
  // Searchable at once (title, and the body when one was given).
  if (ownerId !== null) await indexNewDocument(proof, { title: create.title ?? '', body: content ?? '', yjsId })
  return { docId, url: `/d/${docId}` }
}

/** Title, description, audience and language of the new row (each validated); returns the language. */
function applyDocumentProperties(create: Omit<CreateDocInput, 'ownerId' | 'workspaceId'>, input: CreateDocumentParams): string | null {
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
  return language
}

function resolveTemplate(templateId: string): TemplateMeta {
  const template = getTemplate(templateId)
  if (!template) {
    throw createError({ statusCode: 400, message: 'Unknown templateId' })
  }
  return template
}

/** An anonymous document: the creating browser's key (it alone may delete it) and the accepted terms. */
function applyAnonymousCreator(create: Omit<CreateDocInput, 'ownerId' | 'workspaceId'>, input: CreateDocumentParams): void {
  if (input.anonCreatorKeyHash !== undefined) {
    create.anonCreatorKeyHash = input.anonCreatorKeyHash
  }
  if (input.anonTermsAcceptance !== undefined) {
    create.anonTermsVersion = input.anonTermsAcceptance.termsVersion
    create.anonTermsAcceptedAt = input.anonTermsAcceptance.acceptedAt
  }
}

/**
 * A saved theme / workspace default may carry custom CSS and theme
 * images that point at the uploads of the document it was made in. A
 * brand-new doc has no uploads, so those rules / image URLs are dropped
 * here (the render-time checks would ignore them anyway, this keeps the
 * stored theme honest).
 */
function withCustomCssForNewDoc(theme: DocTheme, docId: string): DocTheme {
  const images = themeImagesForDoc(theme, docId).theme
  const adapted = adaptCustomCssToDoc(images.customCss, { docId })
  return adapted.dropped.length === 0 ? images : { ...images, customCss: adapted.css }
}

async function resolveWorkspace(raw: string | null | undefined, owner: UserScope | null): Promise<WorkspaceAccess<'editor'> | null> {
  if (raw === undefined || raw === null || raw.length === 0) return null
  if (owner == null) {
    throw createError({ statusCode: 401, message: 'Login required to use workspaces' })
  }
  const member = await proveWorkspaceAccess(owner.userId, raw, 'member')
  if (member === null) {
    throw createError({ statusCode: 403, message: 'Not a member of this workspace' })
  }
  if (!member.allows('editor')) {
    throw apiError('workspace/role-required')
  }
  return member
}

function parseTitle(raw: string | undefined): string | null {
  if (raw === undefined) return null
  const trimmed = raw.trim()
  if (trimmed.length > DOC_TITLE_MAX_LENGTH) {
    throw createError({ statusCode: 400, message: 'Title too long' })
  }
  return trimmed.length > 0 ? trimmed : null
}

function parseDescription(raw: string | undefined): string | null {
  if (raw === undefined) return null
  if (raw.length > DOC_DESCRIPTION_MAX_LENGTH) {
    throw createError({ statusCode: 400, message: `Description too long (max ${DOC_DESCRIPTION_MAX_LENGTH})` })
  }
  return raw.trim()
}

function parseContent(raw: string | undefined, templateId: string | undefined, max: number): string | null {
  if (raw === undefined || raw.length === 0) return null
  if (templateId !== undefined) {
    throw createError({ statusCode: 400, message: 'Pass content OR templateId, not both' })
  }
  if (raw.length > max) {
    throw apiError('docs/content-too-long', { max })
  }
  return raw
}

/** The folder to file a new document in: one of the workspace's, or of the owner's personal folders. */
async function resolveFolder(raw: string | null | undefined, owner: UserScope | null, workspace: WorkspaceAccess<'editor'> | null): Promise<string | null> {
  if (raw === undefined || raw === null || raw.length === 0) return null
  if (owner == null) throw apiError('folder/not-found')
  const folder = await getFolder(workspace ?? owner, raw)
  if (!folder) throw apiError('folder/not-found')
  return folder.folderId
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

/** Fill the template's cover placeholders into fields the preset leaves empty. */
function withTemplateCover(theme: DocTheme, template: TemplateMeta, language: string): DocTheme {
  const placeholders = templateCover(template, language)
  if (!placeholders) return theme
  const cover = { ...theme.cover }
  if (placeholders.subtitle !== undefined && cover.subtitle === '') cover.subtitle = placeholders.subtitle
  if (placeholders.authors !== undefined && cover.authors.length === 0) cover.authors = [...placeholders.authors]
  if (placeholders.affiliations !== undefined && (cover.affiliations ?? []).length === 0) cover.affiliations = [...placeholders.affiliations]
  if (placeholders.showDate !== undefined) cover.showDate = placeholders.showDate
  return { ...theme, cover }
}

interface ResolvedTheme {
  theme: DocTheme
  /** The built-in preset it came from, if any. */
  preset: string | null
}

async function resolveTheme(
  input: CreateDocumentParams,
  owner: UserScope | null,
  workspace: WorkspaceAccess<'member'> | null,
  template: TemplateMeta | null
): Promise<ResolvedTheme | null> {
  const sources = [input.theme, input.themeId, input.themePreset].filter(v => v !== undefined).length
  if (sources > 1) {
    throw createError({ statusCode: 400, message: 'Pass one of theme, themeId OR themePreset, not more' })
  }
  if (input.theme !== undefined) return { theme: input.theme, preset: null }
  if (input.themeId !== undefined) {
    if (owner == null) {
      throw createError({ statusCode: 401, message: 'Login required to use saved themes' })
    }
    const saved = await getThemeById(owner, input.themeId)
    if (!saved) {
      throw createError({ statusCode: 404, message: 'Saved theme not found' })
    }
    return { theme: saved.theme, preset: null }
  }
  if (input.themePreset !== undefined) {
    const preset = THEME_PRESETS.find(p => p.id === input.themePreset)
    if (!preset) {
      throw createError({ statusCode: 400, message: 'Unknown themePreset' })
    }
    return { theme: preset.theme, preset: preset.id }
  }
  const design = template?.design ? THEME_PRESETS.find(p => p.id === template.design) : undefined
  if (design) return { theme: design.theme, preset: design.id }
  if (workspace !== null) {
    const ws = await getWorkspace(workspace)
    return ws?.defaultTheme ? { theme: ws.defaultTheme, preset: null } : null
  }
  return null
}
