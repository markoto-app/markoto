// Translates the model's tool calls (Mistral via LiteLLM) into Y.Doc
// operations on a document shared via Hocuspocus. Edits appear live on
// every connected client.
//
// Entry point: `executeFunctionByName(session, name, args)` — dispatches a
// validated tool call to the right handler.

import type { AgenticPart as Part } from './agentic/aiTypes'
import { TOOL_HANDLERS, KNOWN_TOOL_NAMES } from './agentic/toolHandlers'
import { litellmCompletion, litellmImage } from './litellm/createCompletion'
import { providerRequestFields, withProviderErrors } from './aiProviders/requestFields'
import type { ResolvedAiProvider } from './aiProviders/resolve'
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { nanoid } from 'nanoid'
import * as Y from 'yjs'
import * as Sentry from '@sentry/nuxt'
import type { DocToolContext, MetaToolContext } from './agentic/toolContext'
import { useLitellmForUser } from './litellmClient'
import { FEATURE_TAGS, featureMetadata } from './litellm/featureTags'
import type {
  UpdateThemeInput,
  SetTitleInput,
  ViewImageInput,
  GenerateImageInput,
  SearchKnowledgeInput,
  GetKnowledgeFileInput,
  ReadCommentsInput,
  CreateCommentInput,
  ReplyToCommentInput,
  ResolveCommentInput,
  DeleteCommentInput,
  GetThemeInput,
  ListThemesInput,
  SaveThemeAsPresetInput,
  ListWorkspaceDocumentsInput,
  ListMyDocumentsInput,
  CreateDocumentInput,
  DuplicateDocumentInput,
  ExportDocumentAsMarkdownInput,
  ViewOtherDocumentInput,
  GetPageCountInput,
  ViewPagesInput,
  MessageToUserInput,
  SearchActivityLogInput
} from './agentic/functionTools'
import { renderDocument } from './renderClient'
import { resolveDocProperties } from './docProperties'
import { buildMarkdownExport } from '~~/shared/utils/markdownFrontmatter'
import type { DocTheme } from '~~/shared/types/theme'
import { defaultTheme } from '~~/shared/utils/defaultTheme'
import { isValidTheme } from '~~/shared/utils/themeValidation'
import { themeImagesForDoc } from '~~/shared/utils/themeImages'
import { adaptCustomCssToDoc, formatCustomCssIssues } from '~~/shared/utils/customCss'
import { customCssAppOrigins, themeCustomCssIssues } from './themeCustomCss'
import { capsFor, historyCutoff, planHasFeature, resolveDocPlan, resolveUserPlan } from './entitlements'
import { THEME_PRESETS, themeFromPreset } from '~~/shared/utils/themePresets'
import {
  SAVED_THEME_DESCRIPTION_MAX,
  SAVED_THEME_NAME_MAX,
  checkSavedThemeDescription,
  checkSavedThemeName
} from '~~/shared/config/savedThemes'
import { resolveDocBrand } from './brandKit/docBrand'
import { DOC_OWNED_COVER_FIELDS } from '~~/shared/utils/brandLock'
import { getDoc, getDocWithActorRole, updateDocMeta, listWorkspaceDocsWithOwnerFlag, listOwnedByUser } from '../repos/documents'
import { docStateOf, isEffectiveDocOwner, decideTokenAccess } from '~~/shared/utils/docPermissions'
import { DOWNLOAD_DISABLED_MESSAGE, userMayDownload } from './shareSettings'
import { openTrustedCommentClient } from './commentsServerClient'
import { deletePending, markConfirmed, reservePendingUpload, sumImageBytesInScope } from '../repos/uploads'
import { imageQuotaMessage, resolveImageQuota } from './imageQuota'
import { getKnowledgeWithMarkdown, searchKnowledge } from '../repos/knowledge'
import { getMemberRole } from '../repos/workspaceMembers'
import {
  countThemesByUser,
  createTheme,
  getThemeById,
  listThemesByUser
} from '../repos/themes'
import { getWorkspace } from '../repos/workspaces'
import { canEditDoc, canManageDoc } from './workspaceAccess'
import { createDocument } from './createDocument'
import { duplicateDocument } from './duplicateDocument'
import { useS3Client } from './s3'
import { embedQuery } from './embeddings'
import { assertKnowledgeEmbeddingsReady } from './knowledgeEmbeddingsStatus'
import { appendAiMessage } from '../repos/aiSessionMessages'
import { searchActivity, type ActivityEntry } from '../repos/activity'
import { plainCommentText, stripAiMention } from './agentic/commentTriggerPrompt'
import { fetchExternalImage as fetchExternalImageGuarded, type ExternalImageResult } from './externalImage'
import { budgetExhaustedMessage } from './billingMode'
import { FREE_ALLOWANCE_EXHAUSTED_MESSAGE, isFreeAllowanceExhaustedError } from './litellm/freeTierTeam'
import { AI_COMMENT_AUTHOR_NAME, isAiCommentAuthor } from '~~/shared/ai/author'
import { NO_OP_EDIT_ERROR_PREFIX } from './agentic/editProgress'

export interface ToolResult {
  content: string
  isError: boolean
  /**
   * Extra content parts (e.g. image inlineData) appended to the user
   * message AFTER the functionResponse so the model can see them on the
   * next turn. The internal `functionResponse` shape (pre-migration:
   * Gemini-derived) is JSON-only — binary data has to ride as a
   * sibling `inlineData` part, which the OpenAI-shape translator in
   * `messageTranslation.ts` then re-emits as a follow-up user message
   * with `image_url` parts.
   */
  extraParts?: Part[]
}

function ok(content: string): ToolResult {
  return { content, isError: false }
}

function err(content: string): ToolResult {
  return { content, isError: true }
}

function withLineNumbers(text: string, startLine: number = 1): string {
  const lines = text.split('\n')
  return lines.map((line, i) => `${startLine + i}: ${line}`).join('\n')
}

export function handleView(
  session: DocToolContext,
  input: { view_range?: [number, number], max_characters?: number }
): ToolResult {
  const fullText = session.ytext.toJSON()
  const lines = fullText.split('\n')
  let startLine = 1
  let endLine = lines.length
  if (input.view_range) {
    const [start, end] = input.view_range
    if (start < 1) return err('Error: view_range start must be >= 1')
    startLine = start
    endLine = end === -1 ? lines.length : end
    if (endLine < startLine) return err('Error: view_range end must be >= start')
  }

  const slice = lines.slice(startLine - 1, endLine).join('\n')
  let output = withLineNumbers(slice, startLine)

  if (typeof input.max_characters === 'number' && output.length > input.max_characters) {
    output = output.slice(0, input.max_characters) + '\n[truncated]'
  }

  return ok(output)
}

function findIndexOfOnlyMatch(haystack: string, needle: string): { found: number, count: number } {
  if (needle.length === 0) return { found: -1, count: 0 }
  let count = 0
  let first = -1
  let i = 0
  while (true) {
    const pos = haystack.indexOf(needle, i)
    if (pos === -1) break
    if (count === 0) first = pos
    count += 1
    i = pos + needle.length
  }
  return { found: count === 1 ? first : -1, count }
}

export function handleStrReplace(
  session: DocToolContext,
  input: { old_str: string, new_str: string }
): ToolResult {
  if (input.old_str.length === 0) {
    return err('Error: old_str cannot be empty (use `insert_text` for empty insertion)')
  }

  const full = session.ytext.toJSON()
  const { found, count } = findIndexOfOnlyMatch(full, input.old_str)

  if (count === 0) {
    return err('Error: No match found for old_str. The string must match the document text exactly, including whitespace — call view_document to see it. The document context and conversation history are not part of the document and cannot be edited.')
  }
  if (count > 1) {
    return err(`Error: Found ${count} matches for old_str. Please provide more surrounding context to make a unique match.`)
  }
  // A replacement with itself changes nothing. Reporting it as a
  // success let the model "fix" the same passage over and over.
  if (input.old_str === input.new_str) {
    return err(`${NO_OP_EDIT_ERROR_PREFIX}: new_str is identical to old_str, so the document already reads this way. Do not repeat this call. If the request is done, finish without calling another tool.`)
  }

  session.updateStatus('editing', 'Applying edit…')

  const origin = `ai:assistant:${session.sessionId}`
  session.ydoc.transact(() => {
    session.ytext.delete(found, input.old_str.length)
    session.ytext.insert(found, input.new_str)
  }, origin)

  return ok(`Replaced text at exactly one location. ${describeEditedRegion(session.ytext.toJSON(), found, input.new_str.length)}`)
}

/** Lines shown back to the model after an edit (plus one line of context on each side). */
const EDIT_ECHO_MAX_LINES = 24
const EDIT_ECHO_MAX_CHARS = 2400

/**
 * Show the model the lines its edit produced, numbered like
 * `view_document`, with one line of context around them. Without it the
 * model never saw the result (blank lines in particular) and kept
 * re-editing the same spot.
 *
 * @internal exported for unit tests; not part of the public API.
 */
function describeEditedRegion(full: string, start: number, length: number): string {
  const lines = full.split('\n')
  const firstLine = full.slice(0, start).split('\n').length
  const insertedNewlines = full.slice(start, start + length).split('\n').length - 1
  // An insertion that ends with a newline ends on the line before.
  const endsWithNewline = length > 0 && full[start + length - 1] === '\n'
  const lastLine = Math.max(firstLine, firstLine + insertedNewlines - (endsWithNewline ? 1 : 0))
  if (length === 0) return `The text at line ${firstLine} was removed.`
  const from = Math.max(1, firstLine - 1)
  const to = Math.min(lines.length, lastLine + 1)
  const span = firstLine === lastLine ? `Line ${firstLine} now reads` : `Lines ${firstLine}-${lastLine} now read`
  if (lastLine - firstLine + 1 > EDIT_ECHO_MAX_LINES) {
    return `Lines ${firstLine}-${lastLine} now hold the new text (${lastLine - firstLine + 1} lines; call view_document to read it).`
  }
  let echo = withLineNumbers(lines.slice(from - 1, to).join('\n'), from)
  if (echo.length > EDIT_ECHO_MAX_CHARS) echo = echo.slice(0, EDIT_ECHO_MAX_CHARS) + '\n[truncated]'
  return `${span} (with one line of context on each side):\n${echo}`
}

/**
 * Resolve a 1-indexed "insert after line N" into a character offset
 * into `full`. Returns null if the line is beyond EOF.
 *
 * - insert_line=0 → 0 (beginning of file)
 * - insert_line=N → start of line N+1
 * - insert_line === lines.length → end of file
 *
 * The +1-per-newline tally overshoots when the doc has no trailing
 * newline and we're appending; `Math.min(idx, full.length)` clamps us
 * back. Mid-doc positions never exceed total length, so they're
 * unaffected.
 */
/** @internal exported for unit tests; not part of the public API. */
export function lineToCharOffset(full: string, insertLine: number): number | null {
  const lines = full.split('\n')
  if (insertLine > lines.length) return null
  let idx = 0
  for (let i = 0; i < insertLine; i++) {
    idx += lines[i]!.length + 1
  }
  return Math.min(idx, full.length)
}

export function handleInsert(
  session: DocToolContext,
  input: { insert_line: number, insert_text: string }
): ToolResult {
  const full = session.ytext.toJSON()
  const idx = lineToCharOffset(full, input.insert_line)
  if (idx === null) {
    const lineCount = full.split('\n').length
    return err(`Error: insert_line ${input.insert_line} is beyond the end of the file (${lineCount} lines)`)
  }

  session.updateStatus('editing', 'Applying insert…')

  const origin = `ai:assistant:${session.sessionId}`
  // Ensure the insertion itself ends with a newline so it forms clean lines.
  const insertText = input.insert_text.endsWith('\n') ? input.insert_text : input.insert_text + '\n'
  session.ydoc.transact(() => {
    session.ytext.insert(idx, insertText)
  }, origin)

  return ok(`Inserted text after line ${input.insert_line}. ${describeEditedRegion(session.ytext.toJSON(), idx, insertText.length)}`)
}

// --- Theme update ---------------------------------------------------------

/**
 * Numeric fields are declared as string enums in the Zod schema for
 * function-call schema stability (carried over from pre-Phase-5
 * Gemini-era constraints): weight (headings), columns (layout),
 * maxDepth (toc). Coerce them back to numbers before deep-merge +
 * isValidTheme.
 */
/** @internal exported for unit tests; not part of the public API. */
export function coerceThemePatch(patch: UpdateThemeInput): Record<string, unknown> {
  const out: Record<string, unknown> = { ...patch }
  // Directives (NOT theme fields) — strip so they don't leak into
  // mergeTheme and land on the final DocTheme.
  delete out.preset
  delete out.theme_id
  delete out.from_workspace_default
  if (patch.headings?.weight !== undefined) {
    out.headings = { ...patch.headings, weight: Number(patch.headings.weight) }
  }
  if (patch.layout?.columns !== undefined) {
    out.layout = { ...patch.layout, columns: Number(patch.layout.columns) }
  }
  if (patch.toc?.maxDepth !== undefined) {
    out.toc = { ...patch.toc, maxDepth: Number(patch.toc.maxDepth) }
  }
  return out
}

/**
 * Deep-merge a partial theme patch over a complete current theme: top-level
 * sections (`body`), their fields (`body.size`) and — for object-valued
 * fields like `headings.levels` — one level further, so a patch for
 * `levels.h1` keeps `levels.h2`. The entry itself (`levels.h1`) is
 * replaced as a whole (`{}` clears it); arrays are replaced.
 */
/** @internal exported for unit tests; not part of the public API. */
export function mergeTheme(current: DocTheme, patch: Record<string, unknown>): DocTheme {
  const base: Record<string, unknown> = { ...current }
  const merged: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (isPlainRecord(value)) {
      const section = base[key]
      merged[key] = mergeSection(isPlainRecord(section) ? section : {}, value)
    } else if (value !== undefined) {
      merged[key] = value
    }
  }
  return merged as unknown as DocTheme
}

function mergeSection(current: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...current }
  for (const [field, value] of Object.entries(patch)) {
    if (value === undefined) continue
    const existing = current[field]
    out[field] = isPlainRecord(value) && isPlainRecord(existing) ? { ...existing, ...value } : value
  }
  return out
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Short human-readable summary of what the patch changed.
 * @internal exported for unit tests; not part of the public API.
 */
export function summarizePatch(patch: UpdateThemeInput): string {
  const parts: string[] = []
  if (patch.preset) parts.push(`preset=${patch.preset}`)
  if (patch.theme_id) parts.push(`saved=${patch.theme_id}`)
  if (patch.from_workspace_default) parts.push('workspace-default')
  // Directive keys are tracked above; everything else is a theme-field
  // section. `from_workspace_default` is a boolean (not an object), so
  // the `typeof === 'object'` filter excludes it naturally — listed
  // here for the linter / readers.
  const DIRECTIVE_KEYS = new Set(['preset', 'theme_id', 'from_workspace_default'])
  const touched = Object.entries(patch)
    .filter(([k, v]) => !DIRECTIVE_KEYS.has(k) && v && typeof v === 'object' && Object.keys(v).length > 0)
    .map(([k]) => k)
  // customCss is a string field, so the object filter above skips it.
  if (patch.customCss !== undefined) touched.push('customCss')
  if (touched.length) parts.push(touched.join(', '))
  return parts.length ? parts.join(' + ') : '(no changes)'
}

async function checkBrandLock(docId: string, input: UpdateThemeInput): Promise<ToolResult | null> {
  const doc = await getDoc(docId)
  if (!(await resolveDocBrand(doc?.workspaceId ?? null)).lockedTheme) return null
  const entries = Object.entries(input as Record<string, unknown>).filter(([, v]) => v !== undefined && v !== null && v !== false)
  const outside = entries.filter(([k]) => k !== 'cover').map(([k]) => k)
  const cover = (input as { cover?: Record<string, unknown> }).cover
  const coverOutside = cover ? Object.keys(cover).filter(k => cover[k] !== undefined && !(DOC_OWNED_COVER_FIELDS as readonly string[]).includes(k)) : []
  if (outside.length === 0 && coverOutside.length === 0) return null
  return err(`Error: this workspace's admins locked the design — nothing was changed. Every document in the workspace uses the workspace design; only the cover ${DOC_OWNED_COVER_FIELDS.join(', ')} can be changed per document. Tell the user to ask a workspace admin to change the workspace design (Brand kit) if they need a different look.`)
}

export async function handleUpdateTheme(
  session: DocToolContext,
  input: UpdateThemeInput
): Promise<ToolResult> {
  const conflictErr = checkBaseSourceConflict(input)
  if (conflictErr) return conflictErr

  // Brand kit (WP10): a locked workspace design — only the cover text is
  // the document's own. Anything else would be stored but never shown.
  const lockErr = await checkBrandLock(session.docId, input)
  if (lockErr) return lockErr

  const baseResult = await resolveBaseTheme(session, input)
  if (!baseResult.ok) return baseResult.error

  // Image URLs (cover logo, header/footer image) may only point at this
  // document's uploads. Foreign or malformed ones — from the patch or
  // from a base theme made in another document — are cleared first so
  // the result can validate, and the model is told.
  const images = themeImagesForDoc(mergeTheme(baseResult.theme, coerceThemePatch(input)), session.docId)
  const merged = images.theme
  if (!isValidTheme(merged)) {
    // Should never happen — the Zod schema's enums/ranges mirror
    // isValidTheme — but this is defence-in-depth so we never write
    // structurally invalid JSON into the DB or Y.Doc.
    return err('Error: merged theme failed validation. Try narrower changes.')
  }

  // Plan gate: a document whose plan lacks custom CSS can't get NEW CSS
  // from the model (CSS already stored, or carried by the base theme, is
  // kept but not applied — the renderers drop it).
  if (typeof input.customCss === 'string' && input.customCss.trim() !== ''
    && !planHasFeature(await resolveDocPlan(session.docId), 'customCss')) {
    return err('Error: custom CSS is not included in this document\'s plan — nothing was changed. Retry without customCss, or tell the user it needs a plan with custom CSS.')
  }

  const css = resolveThemeCustomCss(merged, input.customCss !== undefined, session.docId, customCssAppOrigins())
  if (!css.ok) return err(css.error)

  session.updateStatus('editing', 'Updating theme…')
  applyThemeToYDoc(session, css.theme)
  await persistThemeBestEffort(session, css.theme)

  const imageNote = images.dropped.length > 0
    ? ` Note: ${images.dropped.join(', ')} did not point at an image uploaded to this document and ${images.dropped.length === 1 ? 'was' : 'were'} cleared.`
    : ''
  return ok(`Theme updated. Changed sections: ${summarizePatch(input)}. Changes are now live in the preview.${css.note}${imageNote}`)
}

/**
 * Custom-CSS gate for `update_theme` (same sanitizer as every other
 * write path). CSS the model SENT is all-or-nothing: any issue rejects
 * the call with line/column details so it can fix and retry. CSS that
 * only came along with the base theme (a saved theme / workspace
 * default made in another document) is adapted instead: rules that
 * can't work here — usually another document's uploaded images — are
 * dropped and the result says so.
 *
 * @internal exported for unit tests; not part of the public API.
 */
export function resolveThemeCustomCss(
  merged: DocTheme,
  cssFromPatch: boolean,
  docId: string,
  origins: readonly string[]
): { ok: true, theme: DocTheme, note: string } | { ok: false, error: string } {
  if (cssFromPatch) {
    const issues = themeCustomCssIssues(merged, docId, origins)
    if (issues.length > 0) {
      return { ok: false, error: `Error: customCss rejected — nothing was changed. Fix these and retry:\n${formatCustomCssIssues(issues)}` }
    }
    return { ok: true, theme: merged, note: '' }
  }
  const adapted = adaptCustomCssToDoc(merged.customCss, { docId, allowedOrigins: origins })
  if (adapted.dropped.length === 0) return { ok: true, theme: merged, note: '' }
  return {
    ok: true,
    theme: { ...merged, customCss: adapted.css },
    note: ` Note: ${adapted.dropped.length} custom CSS rule(s) from the base theme could not be used in this document and were removed.`
  }
}

type BaseResolution = { ok: true, theme: DocTheme } | { ok: false, error: ToolResult }

/**
 * Base theme sources are mutually exclusive in priority order:
 *   - `preset`                 — built-in id (markoto, modern, …)
 *   - `theme_id`               — initiator's own saved-theme id
 *   - `from_workspace_default` — workspace default (snapshot)
 *   - default                  — current ymeta.theme → DB → markoto
 *
 * Passing more than one is a usage error; surface it loudly so the
 * model self-corrects rather than silently picking one. Other fields
 * in the same call merge on top of whichever base is chosen, so
 * "preset arxiv with my brand red" is one call.
 */
function checkBaseSourceConflict(input: UpdateThemeInput): ToolResult | null {
  const baseSources: string[] = []
  if (input.preset) baseSources.push('preset')
  if (input.theme_id) baseSources.push('theme_id')
  if (input.from_workspace_default) baseSources.push('from_workspace_default')
  if (baseSources.length > 1) {
    return err(`Error: pass only ONE of preset/theme_id/from_workspace_default; received: ${baseSources.join(', ')}.`)
  }
  return null
}

/**
 * Resolve the base theme by source. Saved themes are per-user; we tie
 * ownership to the SESSION INITIATOR (the human who triggered the
 * loop), not the AI's synthetic principal — so an AI session can't
 * access another user's saved themes even if the caller hallucinates
 * an id. Returns a `ToolResult` with `error:true` on resolution
 * failure (preset id unknown, saved theme missing, workspace default
 * unset).
 */
async function resolveBaseTheme(session: DocToolContext, input: UpdateThemeInput): Promise<BaseResolution> {
  if (input.preset) {
    const preset = THEME_PRESETS.find(p => p.id === input.preset)
    if (!preset) {
      // Should be unreachable — Zod enum restricts `preset` to known ids.
      return { ok: false, error: err(`Error: Unknown preset "${input.preset}".`) }
    }
    // Keep the document's own custom CSS; a preset's template CSS goes in
    // front of it (same behaviour as the theme panel).
    const current = await resolveCurrentTheme(session)
    return { ok: true, theme: themeFromPreset(preset, current.customCss) }
  }
  if (input.theme_id) {
    const saved = await getThemeById(input.theme_id, session.initiatorUserId)
    if (!saved) {
      return { ok: false, error: err(`Error: saved theme "${input.theme_id}" not found. Call list_themes for valid ids.`) }
    }
    return { ok: true, theme: saved.theme }
  }
  if (input.from_workspace_default) {
    if (!session.workspaceId) {
      return { ok: false, error: err('Error: from_workspace_default requires the document to be in a workspace.') }
    }
    const ws = await getWorkspace(session.workspaceId)
    if (!ws?.defaultTheme) {
      return { ok: false, error: err('Error: this workspace has no default theme set. Ask an admin to set one, or pick a preset / saved theme instead.') }
    }
    return { ok: true, theme: ws.defaultTheme }
  }
  return { ok: true, theme: await resolveCurrentTheme(session) }
}

function applyThemeToYDoc(session: DocToolContext, merged: DocTheme): void {
  const origin = `ai:assistant:${session.sessionId}`
  session.ydoc.transact(() => {
    session.ymeta.set('theme', merged)
  }, origin)
}

/**
 * Persist to DB so fresh visitors on a new socket see the new theme
 * during the window before y-postgresql replays Y.js state. Mirrors
 * the client-side `persistTheme` debounce in `useDocument.ts`.
 *
 * Best-effort: Y.js broadcast already landed the change live to
 * everyone. Worst case on a DB hiccup: a new visitor sees stale
 * theme for the few hundred ms between connect and first Y.js sync.
 */
async function persistThemeBestEffort(session: DocToolContext, merged: DocTheme): Promise<void> {
  try {
    await updateDocMeta(session.docId, { theme: merged })
  } catch (e) {
    console.warn(`[aiToolAdapter] theme DB persist failed for ${session.docId}:`, e)
    Sentry.captureException(e, {
      tags: { component: 'aiToolAdapter', event: 'theme_persist_failed', docId: session.docId }
    })
  }
}

// --- Theme inspection / preset management --------------------------------

/**
 * Resolve the document's current theme, in the same priority order
 * `handleUpdateTheme` uses for its no-base-source path:
 *   ymeta.theme → DB documents.theme JSONB → markoto default.
 *
 * Shared because both `get_theme` and `save_theme_as_preset` need
 * "what theme is the doc using right NOW," and we want them in lockstep.
 */
async function resolveCurrentTheme(session: DocToolContext): Promise<DocTheme> {
  const fromYmeta = session.ymeta.get('theme')
  if (isValidTheme(fromYmeta)) return fromYmeta
  const doc = await getDoc(session.docId)
  return (doc?.theme && isValidTheme(doc.theme)) ? doc.theme : defaultTheme
}

export async function handleGetTheme(
  session: DocToolContext,
  _input: GetThemeInput
): Promise<ToolResult> {
  const theme = await resolveCurrentTheme(session)
  // Pretty-print so the model can read structure in the conversation
  // log. Stringification is bounded — DocTheme is small and flat (a
  // few hundred chars when minified).
  return ok(JSON.stringify(theme, null, 2))
}

export async function handleListThemes(
  session: MetaToolContext,
  _input: ListThemesInput
): Promise<ToolResult> {
  // Saved themes are SCOPED TO THE SESSION INITIATOR — never the AI's
  // synthetic principal. This is the same ownership boundary
  // `handleUpdateTheme` enforces when accepting a `theme_id`.
  const saved = await listThemesByUser(session.initiatorUserId)
  let workspaceDefault: DocTheme | null = null
  if (session.workspaceId) {
    const ws = await getWorkspace(session.workspaceId)
    workspaceDefault = ws?.defaultTheme ?? null
  }

  // Surface the model's two halves clearly: a structured list of
  // saved themes (ids included for `theme_id` callbacks) plus the
  // workspace default as a separate field. Dumping JSON is more
  // useful than a prose summary because the next likely action is
  // `update_theme` with field-level overrides — the model wants to
  // diff the JSONs.
  const payload = {
    savedThemes: saved.map(s => ({
      theme_id: s.themeId,
      name: s.name,
      description: s.description,
      theme: s.theme
    })),
    workspaceDefault: workspaceDefault
      ? { theme: workspaceDefault, scope: 'workspace' as const }
      : null,
    notes: [
      'Pass theme_id to update_theme to apply a saved theme as the base.',
      'Pass from_workspace_default: true to apply the workspace default.',
      'Both replace the base; sibling fields (body.*, headings.*, color.*) merge on top.'
    ]
  }
  return ok(JSON.stringify(payload, null, 2))
}

export async function handleSaveThemeAsPreset(
  session: DocToolContext,
  input: SaveThemeAsPresetInput
): Promise<ToolResult> {
  const nameCheck = checkSavedThemeName(input.name)
  if (!nameCheck.ok) {
    return err(nameCheck.issue === 'too-long'
      ? `Error: name too long (max ${SAVED_THEME_NAME_MAX}).`
      : `Error: name is required (1–${SAVED_THEME_NAME_MAX} chars).`)
  }
  const name = nameCheck.value
  const descriptionCheck = checkSavedThemeDescription(input.description)
  if (!descriptionCheck.ok) {
    return err(`Error: description too long (max ${SAVED_THEME_DESCRIPTION_MAX}).`)
  }

  // Saved themes are personal — anonymous AI sessions (no logged-in
  // initiator) can't have saved themes. The `/api/ai/prompt` route
  // requires login, so this branch is defence-in-depth.
  if (!session.initiatorUserId) {
    return err('Error: saving a theme requires a logged-in user.')
  }

  // Cap check before write — the same plan limit (`savedThemes`) the
  // REST endpoint enforces. The cap is correctness-critical (storage
  // growth), not a rate limit, so we re-check rather than relying on a
  // Valkey hint.
  const owned = await countThemesByUser(session.initiatorUserId)
  const savedThemesLimit = capsFor(await resolveUserPlan(session.initiatorUserId)).savedThemes
  if (owned >= savedThemesLimit) {
    return err(`Error: you've reached the saved-theme limit of the user's plan (${savedThemesLimit}). Ask the user to delete an unused saved theme first.`)
  }

  const theme = await resolveCurrentTheme(session)

  session.updateStatus('tool', `Saving theme as "${name.slice(0, 40)}"…`)

  const themeId = nanoid(10)
  await createTheme({
    themeId,
    userId: session.initiatorUserId,
    name,
    description: descriptionCheck.value,
    theme
  })

  return ok(`Saved current theme as "${name}" (theme_id: ${themeId}). It's now in the user's saved themes; reapply later via update_theme with theme_id.`)
}

// --- Cross-document reads -------------------------------------------------

/**
 * Strip a markoto URL down to a bare doc id. Accepts:
 *   - `xyz123abc`
 *   - `/d/xyz123abc`
 *   - `https://markoto.app/d/xyz123abc`
 *   - `markoto.app/d/xyz123abc?slide=2`
 *   - any host (so users on `localhost:3000` or staging URLs work)
 *
 * Returns null when no recognisable id can be extracted. The id rule
 * `[A-Za-z0-9_-]+` matches nanoid output and survives any future id
 * shape change as long as the alphabet stays URL-safe.
 *
 * @internal exported for unit tests; not part of the public API.
 */
export function parseDocIdFromInput(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  // Try URL-shape match first. Doesn't matter whether the input has a
  // scheme — `/d/<id>` is the load-bearing piece.
  const urlMatch = /\/d\/([A-Za-z0-9_-]+)(?:[/?#]|$)/.exec(trimmed)
  if (urlMatch) return urlMatch[1] ?? null
  // Otherwise treat as a bare id only if the WHOLE string matches the
  // id alphabet (not "https://example.com" with no `/d/` segment).
  if (/^[A-Za-z0-9_-]+$/.test(trimmed)) return trimmed
  return null
}

export async function handleListWorkspaceDocuments(
  session: MetaToolContext,
  _input: ListWorkspaceDocumentsInput
): Promise<ToolResult> {
  if (!session.workspaceId) {
    return err('Error: list_workspace_documents requires the current document to be in a workspace.')
  }

  // Reuse the existing repo helper that powers /api/workspaces/:id —
  // identical fields, identical ownership flag computation, and the
  // same membership check happens before we get here (the AI session
  // belongs to a workspace member or it would have been rejected at
  // /api/ai/prompt time).
  const rows = await listWorkspaceDocsWithOwnerFlag(session.workspaceId, session.initiatorUserId)
  // Drop the current document from the list — the AI already has it
  // open, including it would be confusing and tempt redundant calls
  // to view_other_document on the same id it's editing.
  const visible = rows.filter(r => r.docId !== session.docId)

  if (visible.length === 0) {
    return ok('This workspace has no other documents (only the current one). Nothing to summarise or cross-reference.')
  }

  const payload = {
    workspace_id: session.workspaceId,
    excluded_current_doc_id: session.docId,
    documents: visible.map(r => ({
      doc_id: r.docId,
      title: r.title,
      description: r.description,
      language: r.language,
      access_mode: r.accessMode,
      last_active: r.lastActive instanceof Date ? r.lastActive.toISOString() : r.lastActive,
      is_owner: r.isOwner
    })),
    notes: [
      'Pass `doc_id` to view_other_document to read a specific entry.',
      'is_owner=true means the initiator created the doc; both owned and shared workspace docs appear here.'
    ]
  }
  return ok(JSON.stringify(payload, null, 2))
}

const LIST_MY_DOCUMENTS_DEFAULT_LIMIT = 25

export async function handleListMyDocuments(
  session: MetaToolContext,
  input: ListMyDocumentsInput
): Promise<ToolResult> {
  // Initiator-scoped — ownership is the truth source. The session's
  // synthetic principal is irrelevant here; we always look up against
  // the real human's id (same pattern handleListThemes,
  // handleSaveThemeAsPreset use).
  const limit = input.limit ?? LIST_MY_DOCUMENTS_DEFAULT_LIMIT
  const rows = await listOwnedByUser(session.initiatorUserId)
  const sliced = rows.slice(0, limit)

  if (sliced.length === 0) {
    return ok('You don\'t own any documents yet. Create one with `create_document` (when available), or open a public doc by URL via `view_other_document`.')
  }

  const payload = {
    documents: sliced.map(r => ({
      doc_id: r.docId,
      title: r.title,
      description: r.description,
      language: r.language,
      access_mode: r.accessMode,
      workspace_id: r.workspaceId,
      word_count: r.wordCount,
      size_bytes: r.sizeBytes,
      last_active: r.lastActive instanceof Date ? r.lastActive.toISOString() : r.lastActive
    })),
    total_owned: rows.length,
    returned: sliced.length,
    notes: [
      'Sorted most-recently-active first.',
      'Pass `doc_id` to view_other_document to read a specific entry.',
      'workspace_id is null for standalone (non-workspace) documents.'
    ]
  }
  return ok(JSON.stringify(payload, null, 2))
}

// ─── Host-style tools (Phase 4) ──────────────────────────────────────

export async function handleCreateDocument(
  session: MetaToolContext,
  input: CreateDocumentInput
): Promise<ToolResult> {
  // Anonymous initiators can't reach this path — every consumer
  // (MCP wrapper + agentic loop's prompt endpoint) requires an
  // authenticated user. The session.initiatorUserId is the real
  // human's id; we pass it through as ownerId.
  let result: { docId: string, url: string }
  try {
    result = await createDocument({
      ownerId: session.initiatorUserId,
      title: input.title,
      description: input.description,
      audience: input.audience as Parameters<typeof createDocument>[0]['audience'],
      language: input.language,
      templateId: input.template_id,
      themePreset: input.theme_preset,
      themeId: input.theme_id,
      workspaceId: input.workspace_id ?? null
    })
  } catch (e) {
    // createDocument throws createError(...); bubble the user-facing
    // message up as a tool error so the model self-corrects (e.g.
    // "Not a member of this workspace" → model picks a different
    // workspace_id or omits it).
    const msg = e instanceof Error ? e.message : 'Document creation failed'
    return err(`Error: ${msg}`)
  }

  // Optional initial markdown — open a transient Hocuspocus client on
  // the new doc, insert the body in one transact, disconnect. Mirrors
  // the `openTrustedCommentClient` pattern (server-side mutation
  // broadcast live so any other client connecting in the next few
  // seconds sees the seeded body via Y.js sync, not a refresh).
  //
  // Origin tag: 'seed:{userId}' — the activity_log row sync-server
  // emits for this transact carries this string in `actor_principal`,
  // so the audit chain still resolves to the human (no agent kind,
  // because seeding isn't an agent action — just bootstrapping).
  if (input.initial_markdown && input.initial_markdown.length > 0) {
    try {
      const client = await openTrustedCommentClient(
        result.docId,
        `seed:${session.initiatorUserId}`
      )
      try {
        const ytext = client.ydoc.getText('content')
        client.ydoc.transact(() => {
          ytext.insert(0, input.initial_markdown!)
        }, `seed:${session.initiatorUserId}`)
      } finally {
        await client.destroy()
      }
    } catch (e) {
      // Doc was created successfully; seeding failed. Surface as a
      // partial-success message so the caller knows to either retry
      // the seed or use insert_text.
      const msg = e instanceof Error ? e.message : 'unknown'
      return ok(JSON.stringify({
        doc_id: result.docId,
        url: result.url,
        warning: `Document created but initial_markdown seed failed: ${msg}. Use insert_text({doc_id: "${result.docId}", insert_line: 0, insert_text: "..."}) to populate.`
      }, null, 2))
    }
  }

  return ok(JSON.stringify({
    doc_id: result.docId,
    url: result.url
  }, null, 2))
}

export async function handleDuplicateDocument(
  session: MetaToolContext,
  input: DuplicateDocumentInput
): Promise<ToolResult> {
  // Authz mirrors the in-app duplicate endpoint:
  //   - canEditDoc on source (anyone who can edit can fork)
  //   - admin/editor on target workspace if specified (else inherit
  //     source's workspace)
  const source = await getDoc(input.source_doc_id)
  if (!source) {
    return err(`Error: source document "${input.source_doc_id}" not found, or you don't have access to it.`)
  }
  if (!(await canEditDoc(session.initiatorUserId, input.source_doc_id))) {
    return err(`Error: source document "${input.source_doc_id}" not found, or you don't have access to it.`)
  }
  // View only (WP9): a copy is a download.
  if (!(await userMayDownload(input.source_doc_id, session.initiatorUserId))) {
    return err(`Error: ${DOWNLOAD_DISABLED_MESSAGE} Tell the user.`)
  }

  // Resolve target workspace. `''` from the schema means "park as
  // personal" (null); `undefined` means "inherit source"; a non-empty
  // string is an explicit target.
  let targetWorkspaceId: string | null
  if (input.workspace_id === undefined) {
    targetWorkspaceId = source.workspaceId
  } else if (input.workspace_id === '') {
    targetWorkspaceId = null
  } else {
    targetWorkspaceId = input.workspace_id
  }
  if (targetWorkspaceId !== null) {
    const role = await getMemberRole(targetWorkspaceId, session.initiatorUserId)
    if (role === null || role === 'viewer') {
      return err(`Error: cannot duplicate into workspace "${targetWorkspaceId}" — must be admin or editor.`)
    }
  }

  const title = input.title?.trim() || `Copy of ${source.title}`
  const newDocId = nanoid(10)
  const config = useRuntimeConfig()
  try {
    await duplicateDocument(
      {
        sourceDocId: input.source_doc_id,
        newDocId,
        ownerId: session.initiatorUserId,
        workspaceId: targetWorkspaceId,
        title
      },
      {
        s3: useS3Client(),
        bucket: config.s3.bucket,
        imageQuota: await resolveImageQuota(session.initiatorUserId, null, targetWorkspaceId)
      }
    )
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Duplicate failed'
    return err(`Error: ${msg}`)
  }
  return ok(JSON.stringify({
    doc_id: newDocId,
    url: `/d/${newDocId}`
  }, null, 2))
}

export async function handleExportDocumentAsMarkdown(
  session: DocToolContext,
  _input: ExportDocumentAsMarkdownInput
): Promise<ToolResult> {
  // The wrapper has already authz-checked + checked out the YDocPool
  // entry, so session.ytext / ymeta are the live synced doc.
  const doc = await getDoc(session.docId)
  if (!doc) return err('Error: document not found.')
  // Share-link controls (WP9): a visitor may not download a view-only doc.
  if (!(await userMayDownload(session.docId, session.initiatorUserId))) {
    return err(`Error: ${DOWNLOAD_DISABLED_MESSAGE} Tell the user.`)
  }
  // Same file the editor's "Download Markdown" writes: markoto YAML
  // frontmatter (theme + properties, live ymeta first, row as fallback)
  // on top of the raw body. NO line-number prefixes — view_document is
  // for inspection; this is for delivery / archival / re-import.
  const props = resolveDocProperties(session.ymeta, doc)
  return ok(buildMarkdownExport(session.ytext.toJSON(), {
    title: props.title,
    description: props.description,
    audience: props.audience,
    language: props.language,
    templateId: props.templateId,
    theme: props.theme ?? defaultTheme
  }))
}

const VIEW_OTHER_DOC_CHAR_CAP = 50_000

export async function handleViewOtherDocument(
  session: MetaToolContext,
  input: ViewOtherDocumentInput
): Promise<ToolResult> {
  const targetId = parseDocIdFromInput(input.doc_id)
  if (!targetId) {
    return err(`Error: could not extract a document id from "${input.doc_id.slice(0, 80)}". Pass either the bare id or a markoto URL like https://markoto.app/d/<id>.`)
  }
  if (targetId === session.docId) {
    return err('Error: this is the current document — call `view_document` instead.')
  }

  const accessResult = await resolveCrossDocAccess(session, targetId)
  if (!accessResult.ok) return accessResult.error
  const ctx = accessResult.ctx

  // Live read via Hocuspocus. Same trusted-client pattern the
  // comment-trigger endpoint uses for peek reads — opens just long
  // enough to get a synced ydoc, reads ytext, disconnects. Catches
  // mid-flight edits that haven't hit y-postgresql yet.
  session.updateStatus('tool', `Reading ${ctx.title || 'document'}…`)
  const bodyResult = await readOtherDocBody(session, targetId)
  if (!bodyResult.ok) return bodyResult.error

  const view = applyViewRange(bodyResult.body, input.view_range)
  const meta = {
    doc_id: targetId,
    title: ctx.title,
    description: ctx.description,
    language: ctx.language,
    audience: ctx.audience,
    access_mode: ctx.accessMode,
    workspace_id: ctx.workspaceId,
    scope: scopeLabelFor(ctx, session.initiatorUserId),
    line_count: view.totalLines,
    showed_lines: { start: view.startLine, end: view.endLineClamped },
    truncated_chars_at: view.truncated ? VIEW_OTHER_DOC_CHAR_CAP : null
  }

  // Body BEFORE meta in the formatted response so the model doesn't
  // have to scroll past the header to find the content. The trailing
  // metadata block is parseable JSON for fields the model wants to
  // reuse (title, scope, etc).
  const trailer = view.truncated
    ? '\n\n[Truncated at 50 000 chars — call view_other_document again with view_range to read more.]'
    : ''
  // Readers know documents by their title, not their id: a summary that
  // cited `workspace doc "Kf50UWihca"` showed the raw id to the user.
  const citeTitle = (ctx.title || 'Untitled').replaceAll(']', ')').replaceAll('[', '(')
  const citation = `\n\nIf you mention or cite this document in the text, call it by its title, or link it exactly like this: [${citeTitle}](/d/${targetId}). Never write the bare document id, and never label the link with another document's title.`
  return ok(`${view.formatted}${trailer}${citation}\n\n--- metadata ---\n${JSON.stringify(meta, null, 2)}`)
}

type CrossDocCtx = NonNullable<Awaited<ReturnType<typeof getDocWithActorRole>>>
type CrossDocAccess = { ok: true, ctx: CrossDocCtx } | { ok: false, error: ToolResult }

/**
 * Mirror `/api/docs/:id/token` exactly. The initiator's permissions
 * are the source of truth — never the AI's synthetic principal — so
 * the AI sees what the human would see by pasting the URL into a
 * browser, no more and no less. 404-shapes mask "doc exists but
 * you can't see it" so a hallucinated id can't enumerate.
 *
 * Password-protected non-member access is surfaced distinctly (the
 * AI can tell the user) rather than 404-masking — there's no way to
 * ship the password through the AI tool surface, so the user has to
 * intervene.
 */
async function resolveCrossDocAccess(session: MetaToolContext, targetId: string): Promise<CrossDocAccess> {
  const ctx = await getDocWithActorRole(targetId, session.initiatorUserId)
  if (!ctx) {
    return { ok: false, error: err(`Error: document "${targetId}" not found, or you don't have access to it.`) }
  }
  const decision = decideTokenAccess(
    docStateOf(ctx),
    {
      userId: session.initiatorUserId,
      workspaceRole: ctx.workspaceRole
    }
  )
  if (decision.outcome === 'allow') return { ok: true, ctx }
  if (decision.outcome === 'password-required') {
    // Workspace membership already bypassed the password gate in
    // `decideTokenAccess`, so this branch only fires for non-member
    // accessors of a password-protected doc.
    return { ok: false, error: err(`Error: document "${targetId}" is password-protected and you're not a workspace member. Ask the user to lift the password or share the doc differently.`) }
  }
  // outcome === 'forbidden' (or any future deny shape). Same
  // anti-enumeration shape used at /api/docs/:id/token's forbidden branch.
  return { ok: false, error: err(`Error: document "${targetId}" not found, or you don't have access to it.`) }
}

/**
 * Title of the document `docRef` (bare id or markoto URL) when `userId`
 * may open it — the same access decision `view_other_document` makes.
 * Null when the reference doesn't parse, the doc doesn't exist, or the
 * user can't open it. Used to label confirmation requests for the
 * session's initiator, so it never reveals more than the user could see.
 */
export async function accessibleDocTitle(userId: number, docRef: string): Promise<string | null> {
  const targetId = parseDocIdFromInput(docRef)
  if (!targetId) return null
  const ctx = await getDocWithActorRole(targetId, userId)
  if (!ctx) return null
  const decision = decideTokenAccess(
    docStateOf(ctx),
    { userId, workspaceRole: ctx.workspaceRole }
  )
  if (decision.outcome !== 'allow') return null
  return ctx.title || targetId
}

type DocBodyResult = { ok: true, body: string } | { ok: false, error: ToolResult }

async function readOtherDocBody(session: MetaToolContext, targetId: string): Promise<DocBodyResult> {
  let client: Awaited<ReturnType<typeof openTrustedCommentClient>> | null = null
  try {
    client = await openTrustedCommentClient(
      targetId,
      `ai-cross-doc-read:${session.initiatorUserId}:${session.sessionId}`
    )
    const ytext = client.ydoc.getText('content')
    return { ok: true, body: ytext.toJSON() }
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'unknown error'
    return { ok: false, error: err(`Error: failed to read document "${targetId}" from sync server: ${msg}.`) }
  } finally {
    if (client) {
      try {
        await client.destroy()
      } catch { /* best-effort cleanup */ }
    }
  }
}

interface ViewSlice {
  formatted: string
  truncated: boolean
  totalLines: number
  startLine: number
  endLineClamped: number
}

/**
 * Apply view_range. Same line-indexing semantics as `view_document` —
 * 1-indexed inclusive, end=-1 means EOF. Validation already happened
 * at the Zod schema (start >= 1, end >= start || end === -1). We
 * still clamp here so a huge end value doesn't crash anything
 * downstream, and we cap the formatted string at
 * `VIEW_OTHER_DOC_CHAR_CAP` chars.
 */
function applyViewRange(body: string, range: ViewOtherDocumentInput['view_range']): ViewSlice {
  const allLines = body.split('\n')
  let startLine = 1
  let endLine = allLines.length
  if (range) {
    const [s, e] = range
    startLine = s!
    endLine = e === -1 ? allLines.length : e!
  }
  const sliceStart = Math.max(0, startLine - 1)
  const sliceEnd = Math.min(allLines.length, endLine)
  const sliced = allLines.slice(sliceStart, sliceEnd)
  let formatted = sliced.map((line, i) => `${startLine + i}: ${line}`).join('\n')
  let truncated = false
  if (formatted.length > VIEW_OTHER_DOC_CHAR_CAP) {
    formatted = formatted.slice(0, VIEW_OTHER_DOC_CHAR_CAP)
    truncated = true
  }
  return { formatted, truncated, totalLines: allLines.length, startLine, endLineClamped: Math.min(allLines.length, endLine) }
}

/**
 * Tells the AI WHY it could read the doc — useful when composing a
 * quote ("From your workspace doc 'Q3 plan': …").
 */
function scopeLabelFor(ctx: CrossDocCtx, initiatorUserId: number): string {
  if (isEffectiveDocOwner(ctx, initiatorUserId)) return 'self'
  if (ctx.workspaceRole) return `workspace:${ctx.workspaceRole}`
  if (ctx.accessMode === 'open-edit') return 'public-edit'
  if (ctx.accessMode === 'open-view') return 'public-view'
  return 'shared'
}

// --- Set title ------------------------------------------------------------

export async function handleSetTitle(
  session: DocToolContext,
  input: SetTitleInput
): Promise<ToolResult> {
  // Zod trims and enforces 1–255; belt-and-braces re-check so an empty
  // trim result never reaches ymeta/DB (the meta.put endpoint also
  // validates server-side, but AI bypasses that route).
  const title = input.title.trim()
  if (title.length === 0) return err('Error: title cannot be empty')
  if (title.length > 255) return err('Error: title too long (max 255 chars)')

  session.updateStatus('editing', 'Updating title…')

  const origin = `ai:assistant:${session.sessionId}`
  session.ydoc.transact(() => {
    session.ymeta.set('title', title)
  }, origin)

  try {
    await updateDocMeta(session.docId, { title })
  } catch (e) {
    // Same tradeoff as theme: Y.js already broadcast the change live;
    // DB failure only affects what brand-new visitors see before sync.
    console.warn(`[aiToolAdapter] title DB persist failed for ${session.docId}:`, e)
    Sentry.captureException(e, {
      tags: { component: 'aiToolAdapter', event: 'title_persist_failed', docId: session.docId }
    })
  }

  return ok(`Title set to "${title}".`)
}

// --- View image -----------------------------------------------------------

// The model accepts a handful of image MIME types inline. Keep the
// allowlist aligned with what our upload pipeline emits plus what
// Mistral's vision model actually renders — reject anything else
// rather than gamble on model behavior.
const ALLOWED_IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/heic',
  'image/heif'
])

// 5 MiB cap: matches the upload flow's practical ceiling, keeps one turn's
// context footprint sane. Modern multimodal models inline up to ~20MB per
// part but a 20MB image on every turn quickly blows up prompt-caching
// economics.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024

// Extracts `{ docId, fileId }` from either a relative path
// (`/api/files/abc/def.png`) or an absolute URL pointing at our own
// /api/files endpoint. Returns null for anything else.
/** @internal exported for unit tests; not part of the public API. */
export function parseInternalFileRef(src: string): { docId: string, fileId: string } | null {
  const match = /\/api\/files\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+\.[A-Za-z0-9]+)(?:$|[?#])/.exec(src)
  if (!match) return null
  return { docId: match[1]!, fileId: match[2]! }
}

async function fetchFromS3(docId: string, fileId: string): Promise<{ bytes: Uint8Array, mimeType: string } | { error: string }> {
  const s3 = useS3Client()
  const config = useRuntimeConfig()
  try {
    const resp = await s3.send(new GetObjectCommand({
      Bucket: config.s3.bucket,
      Key: `docs/${docId}/${fileId}`
    }))
    const mimeType = resp.ContentType ?? 'application/octet-stream'
    if (!ALLOWED_IMAGE_TYPES.has(mimeType)) {
      return { error: `Unsupported image type "${mimeType}". Allowed: ${[...ALLOWED_IMAGE_TYPES].join(', ')}.` }
    }
    if (typeof resp.ContentLength === 'number' && resp.ContentLength > MAX_IMAGE_BYTES) {
      return { error: `Image is ${Math.round(resp.ContentLength / 1024)}KB, which exceeds the ${MAX_IMAGE_BYTES / (1024 * 1024)}MB limit for inlining.` }
    }
    const bytes = await resp.Body!.transformToByteArray()
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      return { error: `Image exceeded the ${MAX_IMAGE_BYTES / (1024 * 1024)}MB limit after fetch.` }
    }
    return { bytes, mimeType }
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error'
    return { error: `Failed to fetch image from storage: ${msg}` }
  }
}

/** `view_image` limits applied to external URLs (see `externalImage.ts`). */
function fetchExternalImage(url: string): Promise<ExternalImageResult> {
  return fetchExternalImageGuarded(url, { allowedTypes: ALLOWED_IMAGE_TYPES, maxBytes: MAX_IMAGE_BYTES })
}

export async function handleViewImage(
  session: MetaToolContext,
  input: ViewImageInput
): Promise<ToolResult> {
  const src = input.src.trim()
  session.updateStatus('tool', 'Fetching image…')

  // Internal /api/files/... path → S3 direct fetch (bypass the HTTP
  // endpoint because we're already server-side with S3 creds). Verify
  // the docId in the URL matches the session's docId so the AI can't be
  // tricked into reading images from docs the initiator shouldn't see.
  const internal = parseInternalFileRef(src)
  let result: { bytes: Uint8Array, mimeType: string } | { error: string }
  if (internal) {
    if (internal.docId !== session.docId) {
      return err('Error: cross-document image reads are not allowed. The image must belong to the current document.')
    }
    result = await fetchFromS3(internal.docId, internal.fileId)
  } else if (/^https?:\/\//i.test(src)) {
    result = await fetchExternalImage(src)
  } else {
    return err(`Error: unsupported image src "${src.slice(0, 80)}…". Use a /api/files/{docId}/{fileId} path or an absolute http(s):// URL.`)
  }

  if ('error' in result) return err(`Error: ${result.error}`)

  const { bytes, mimeType } = result
  const base64 = Buffer.from(bytes).toString('base64')
  const sizeKB = Math.round(bytes.byteLength / 1024)

  return {
    content: `Fetched ${mimeType} image (${sizeKB}KB). See the following image part for the contents.`,
    isError: false,
    extraParts: [{ inlineData: { mimeType, data: base64 } }]
  }
}

// --- Generate image -------------------------------------------------------

// Map the image-gen output MIME (BFL FLUX.2 / pre-Phase-5 Gemini) to
// the extension the upload pipeline uses. (Keep the set narrow — the
// file-id regex in /api/files only accepts these extensions; anything
// else would be unreachable via /api/files.)
const IMAGE_MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp'
}

interface ImageGenOpts {
  /** The session's image provider (BYOK / instance default). Null = unavailable. */
  provider: ResolvedAiProvider | null
  /** Output width in pixels. Default from runtimeConfig (1024). */
  width?: number
  /** Output height in pixels. Default from runtimeConfig (1024). */
  height?: number
  /** Per-user LiteLLM virtual-key bearer token. */
  virtualKey?: string
  /** Workspace context for spend-tagging. */
  workspaceId?: string | null
  /** Initiating user id for spend-tagging. */
  userId?: number | null
  /** Doc the image is being inserted into — drives doc-axis spend tag. */
  docId?: string | null
}

type ImageGenResult = { bytes: Uint8Array, mimeType: string } | { error: string }

/**
 * Generate an image from a text prompt. Two paths, picked by the
 * resolved image provider:
 *
 *   - BYOK (user key, or an instance default with base URL): the user's
 *     OpenAI-compatible images API via LiteLLM's zero-cost `byok/*`
 *     deployment (`/v1/images/generations`).
 *   - Instance default WITHOUT base URL: the operator's LiteLLM model
 *     alias, using the chat-wrapped convention of the bundled
 *     `flux-2-pro` deployment (BFL FLUX.2 [pro], EU-pinned). Platform-paid.
 *
 * Returns raw bytes + MIME type, or an error string. The S3 upload + Y.js
 * insertion happens in `handleGenerateImage` and is shape-agnostic.
 */
async function generateImageBytes(
  prompt: string,
  _signal: AbortSignal,
  opts: ImageGenOpts
): Promise<ImageGenResult> {
  const provider = opts.provider
  if (!provider) {
    return { error: 'Image generation is not available: no image provider is configured. The user can add one under Settings → AI provider.' }
  }
  if (provider.credentials) return generateImageBytesByok(prompt, provider, opts)
  return generateImageBytesBfl(prompt, provider.model, opts)
}

/** Sniff PNG / JPEG / WebP from magic bytes — providers don't always say. */
function sniffImageMime(bytes: Uint8Array): string | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return 'image/jpeg'
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp'
  return null
}

/**
 * OpenAI-style images APIs only accept a few fixed sizes. Map the
 * requested aspect to the nearest of the common gpt-image sizes.
 */
function openAiImageSize(width: number, height: number): string {
  if (width > height * 1.2) return '1536x1024'
  if (height > width * 1.2) return '1024x1536'
  return '1024x1024'
}

// ─── BYOK path: OpenAI-compatible images API ────────────────────────────

async function generateImageBytesByok(
  prompt: string,
  provider: ResolvedAiProvider,
  opts: ImageGenOpts
): Promise<ImageGenResult> {
  if (!opts.virtualKey) return { error: 'Image generation requires a LiteLLM virtual key.' }
  const config = useRuntimeConfig()
  const width = opts.width ?? config.litellm?.imageDefaultWidth ?? 1024
  const height = opts.height ?? config.litellm?.imageDefaultHeight ?? 1024
  try {
    const litellm = useLitellmForUser(opts.virtualKey)
    const fields = await providerRequestFields(provider)
    const resp = await withProviderErrors(provider, () => litellmImage(litellm, {
      ...fields,
      prompt,
      n: 1,
      size: openAiImageSize(width, height),
      ...featureMetadata(FEATURE_TAGS.imageGen, { workspaceId: opts.workspaceId, userId: opts.userId, docId: opts.docId })
    }))
    const first = resp.data?.[0]
    if (first?.b64_json) {
      const bytes = Buffer.from(first.b64_json, 'base64')
      const mimeType = sniffImageMime(bytes)
      if (!mimeType) return { error: 'The image provider returned an unsupported image format.' }
      return { bytes, mimeType }
    }
    if (first?.url) {
      // Some providers (dall-e style) answer with a URL. The URL comes
      // from a third party, so it goes through the same SSRF guard,
      // size cap and MIME allowlist as `view_image`.
      return await fetchExternalImage(first.url)
    }
    return { error: 'The image provider returned no image.' }
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error'
    console.error('[generate_image] [byok] failed:', msg)
    return { error: `Image generation failed: ${msg}` }
  }
}

// ─── BFL FLUX.2 [pro] path (operator alias) ─────────────────────────────

async function generateImageBytesBfl(
  prompt: string,
  model: string,
  opts: ImageGenOpts
): Promise<ImageGenResult> {
  if (!opts.virtualKey) {
    return { error: 'BFL image gen requires a per-user LiteLLM virtual key (Phase 6).' }
  }
  const config = useRuntimeConfig()
  const litellm = useLitellmForUser(opts.virtualKey)
  const width = opts.width ?? config.litellm?.imageDefaultWidth ?? 1024
  const height = opts.height ?? config.litellm?.imageDefaultHeight ?? 1024

  // Custom provider convention (see infra/litellm/custom_handlers.py:
  // BFLFluxProvider). Single user message with JSON-encoded body.
  // Response's content is JSON with {b64_json, url, cost_credits, cost_usd}.
  // prompt_upsampling is intentionally false — the prompt is AI-written
  // and re-LLM-ing it adds latency without benefit.
  try {
    console.log(`[generate_image] [bfl] calling model=${model} ${width}×${height} prompt="${prompt.slice(0, 100)}…"`)
    const resp = await litellmCompletion(litellm, {
      model,
      messages: [{
        role: 'user',
        content: JSON.stringify({ prompt, width, height, prompt_upsampling: false })
      }],
      ...featureMetadata(FEATURE_TAGS.imageGen, {
        workspaceId: opts.workspaceId,
        userId: opts.userId,
        docId: opts.docId
      })
    })
    const content = resp.choices?.[0]?.message?.content ?? ''
    let body: { b64_json?: string, url?: string, cost_usd?: number }
    try {
      body = JSON.parse(content)
    } catch {
      return { error: 'BFL provider returned non-JSON content (proxy misconfig).' }
    }
    if (!body.b64_json) {
      return { error: 'BFL returned no image bytes (provider error or content-moderated).' }
    }
    const bytes = Buffer.from(body.b64_json, 'base64')
    // BFL returns image/jpeg by default for FLUX.2 [pro]. Map MIME →
    // extension via IMAGE_MIME_EXT; if the response ever changes, the
    // upload pipeline will reject unknown MIMEs at /api/files.
    const mimeType = 'image/jpeg'
    console.log(`[generate_image] [bfl] got ${mimeType} image, ${bytes.byteLength} bytes, cost=$${body.cost_usd ?? 'unknown'}`)
    return { bytes, mimeType }
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error'
    console.error('[generate_image] [bfl] threw:', msg)
    Sentry.captureException(e, {
      tags: { component: 'aiToolAdapter', event: 'image_generate_failed', provider: 'bfl' }
    })
    if (isFreeAllowanceExhaustedError(msg)) return { error: FREE_ALLOWANCE_EXHAUSTED_MESSAGE }
    if (msg.includes('budget_exceeded') || msg.includes('Budget has been exceeded')) {
      return { error: budgetExhaustedMessage() }
    }
    return { error: `Image generation failed: ${msg}` }
  }
}

/**
 * Escape characters that would terminate a markdown image `![alt](url)`
 * bracket pair. Alt and caption are user-facing but AI-authored; a
 * stray `]` or `)` would fragment the link.
 */
/** @internal exported for unit tests; not part of the public API. */
export function sanitizeAltText(s: string): string {
  return s.replace(/[[\]()]/g, '').replace(/\s+/g, ' ').trim()
}

export async function handleGenerateImage(
  session: MetaToolContext,
  input: GenerateImageInput
): Promise<ToolResult> {
  // Phase 6: no app-side interaction-charging. The BFL custom provider
  // bills the user's LiteLLM virtual key directly via the chat-completion
  // shape; budget_exceeded surfaces as a `LitellmBudgetExhausted` thrown
  // from `generateImageBytesBfl` (caught + translated to a tool-result
  // error string).
  session.updateStatus('tool', 'Generating image…')

  // 1. Image storage quota — checked BEFORE generating so a full quota
  //    doesn't burn the user's AI budget on an image we can't store. The
  //    atomic reservation (with the real size) happens before the PUT.
  //    A Team / Business workspace document uses the workspace pool (WP3).
  const quota = await resolveImageQuota(session.initiatorUserId, session.docId)
  const quotaBytes = quota.maxBytes
  if (await sumImageBytesInScope(quota.scope) >= quotaBytes) {
    return err(`Error: ${imageQuotaMessage(quotaBytes)}`)
  }

  // 2. Generate. The 5-minute loop deadline is the effective cap — we
  //    don't thread a finer-grained signal here.
  const controller = new AbortController()
  const gen = await generateImageBytes(input.prompt, controller.signal, {
    provider: session.aiProviders.image,
    width: input.width,
    height: input.height,
    virtualKey: session.virtualKey,
    workspaceId: session.workspaceId,
    userId: session.initiatorUserId,
    docId: session.docId
  })
  if ('error' in gen) return err(`Error: ${gen.error}`)

  // 2. Upload to S3 using the same key shape as user uploads so the
  //    existing /api/files endpoint serves it with no extra plumbing.
  session.updateStatus('tool', 'Uploading generated image…')

  const ext = IMAGE_MIME_EXT[gen.mimeType]!
  const fileIdWithExt = `${nanoid(12)}.${ext}`
  const key = `docs/${session.docId}/${fileIdWithExt}`
  const s3 = useS3Client()
  const config = useRuntimeConfig()

  // 3a. Reserve the bytes (pending `uploads` row) atomically against the
  //     quota BEFORE the PUT, so concurrent generations can't overshoot.
  //     Skipped for the anonymous-doc edge case (no FK target). A DB
  //     failure stays non-fatal: an S3 object with no row still serves,
  //     it is just reaped later by orphan-cleanup.
  const doc = await getDoc(session.docId)
  let rowReserved = false
  if (doc) {
    try {
      const reservation = await reservePendingUpload({
        docId: session.docId,
        fileId: fileIdWithExt,
        uploaderId: session.initiatorUserId,
        contentType: gen.mimeType,
        sizeBytes: gen.bytes.byteLength,
        s3Key: key
      }, quotaBytes, quota.scope)
      if (!reservation.reserved) return err(`Error: ${imageQuotaMessage(quotaBytes)}`)
      rowReserved = true
    } catch (e) {
      console.warn(`[aiToolAdapter] uploads row insert failed for ${key}:`, e)
      Sentry.captureException(e, {
        tags: { component: 'aiToolAdapter', event: 'uploads_row_insert_failed', s3Key: key }
      })
    }
  }

  try {
    await s3.send(new PutObjectCommand({
      Bucket: config.s3.bucket,
      Key: key,
      Body: gen.bytes,
      ContentType: gen.mimeType,
      ContentLength: gen.bytes.byteLength
      // Encryption-at-rest is handled at the bucket level in prod
      // (docs/S3-SETUP.md §6). We deliberately do NOT pass
      // `ServerSideEncryption: 'AES256'` per-object because the
      // SeaweedFS backend used in dev/test rejects unknown SSE
      // headers with "We encountered an internal error", and the
      // browser presigned-PUT path (image upload request endpoint)
      // already trusts the bucket default. Keeping both paths
      // symmetric prevents one prod bucket policy change from
      // silently breaking only the AI-image flow.
    }))
  } catch (e) {
    if (rowReserved) {
      await deletePending(key, session.initiatorUserId).catch(() => { /* reaped after 24 h */ })
    }
    const msg = e instanceof Error ? e.message : 'Unknown error'
    return err(`Error: failed to upload generated image: ${msg}`)
  }

  // 3b. Confirm the row so orphan-cleanup doesn't reap it. Server-written
  //     bytes never had a presigned URL, so no staging copy is needed.
  if (rowReserved) {
    try {
      await markConfirmed(key)
    } catch (e) {
      // Non-fatal — see note above.
      console.warn(`[aiToolAdapter] uploads row insert failed for ${key}:`, e)
      Sentry.captureException(e, {
        tags: { component: 'aiToolAdapter', event: 'uploads_row_insert_failed', s3Key: key }
      })
    }
  }

  // 4. Build and return the markdown. Caller chooses placement via a
  //    follow-up insert_text / replace_text call.
  const alt = sanitizeAltText(input.alt)
  const url = `/api/files/${session.docId}/${fileIdWithExt}`
  const md = `![${alt}](${url})`

  const sizeKB = Math.round(gen.bytes.byteLength / 1024)
  // Placement reminder: without it the model tended to drop the image at
  // line 0 (above the title) even when asked for "below the heading".
  return ok(`Generated and uploaded ${gen.mimeType} image (${sizeKB}KB). Markdown reference (copy verbatim into insert_text or replace_text): ${md}\nPlace it where the user asked: insert_text with insert_line = the line it should follow (a document's title is line 1, so "below the heading" is insert_line 1 or later, never 0). Check the line numbers with view_document if you have not seen them yet.`)
}

// --- view_pages / get_page_count -----------------------------------------
//
// Backend-rendered PNGs of paginated pages. The renderer container produces
// these on demand and uploads to S3 keyed by yjs-doc snapshot id; subsequent
// calls hit the cache. Costs interactions because the model's vision
// input is charged per-image — we use 5 per page (same as image
// generation), leaving room for the renderer compute itself.
//
// Cap: 5 pages per call (enforced by Zod). The model is instructed to call
// these tools only when the user references a specific page — burning 25
// interactions speculatively would chew through budget.

export async function handleGetPageCount(
  session: MetaToolContext,
  _input: GetPageCountInput
): Promise<ToolResult> {
  // Phase 6: no app-side interaction-charging. The renderer call below
  // is server-internal — the user only "pays" for the chat-completion
  // turn that issued this tool call (via LiteLLM).
  session.updateStatus('tool', 'Counting pages…')

  try {
    const result = await renderDocument(session.docId, { format: 'png' })
    return ok(`Document has ${result.manifest.pageCount} page(s) under the current theme. Use view_pages to inspect specific pages by 1-indexed number.`)
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'unknown error'
    return err(`Error: failed to render document for page count: ${msg}`)
  }
}

export async function handleViewPages(
  session: MetaToolContext,
  input: ViewPagesInput
): Promise<ToolResult> {
  const requestedPages = Array.from(new Set(input.pages)).sort((a, b) => a - b)

  // Phase 6: no app-side interaction-charging. The page images are
  // injected into the next user turn as `image_url` parts; the
  // per-image input-token cost is billed by LiteLLM on that turn's
  // chat completion (Mistral Small 4.0 vision input).
  session.updateStatus('tool', `Rendering ${requestedPages.length} page${requestedPages.length === 1 ? '' : 's'}…`)

  let manifest
  try {
    const result = await renderDocument(session.docId, { format: 'png' })
    manifest = result.manifest
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'unknown error'
    return err(`Error: failed to render document: ${msg}`)
  }

  // Validate requested pages exist in the rendered output. A user asking
  // "look at page 12" on a 3-page doc gets a clear rejection, not silent
  // empty results.
  const outOfRange = requestedPages.filter(n => n < 1 || n > manifest.pageCount)
  if (outOfRange.length > 0) {
    return err(`Error: requested page(s) ${outOfRange.join(', ')} are out of range. The document has ${manifest.pageCount} page(s).`)
  }

  const config = useRuntimeConfig()
  const s3 = useS3Client()
  const parts: { inlineData: { mimeType: string, data: string } }[] = []
  const captions: string[] = []

  for (const n of requestedPages) {
    // The render folder is the snapshot id plus, for documents with brand
    // inputs, the brand fingerprint — take the key the renderer reported
    // (matched by file name rather than trusting array order).
    const key = manifest.pageKeys.find(k => k.endsWith(`/page-${n}.png`))
    if (!key) return err(`Error: failed to fetch page ${n}: not in the render`)
    try {
      const got = await s3.send(new GetObjectCommand({
        Bucket: config.s3.bucket,
        Key: key
      }))
      const bytes = await got.Body!.transformToByteArray()
      const base64 = Buffer.from(bytes).toString('base64')
      parts.push({ inlineData: { mimeType: 'image/png', data: base64 } })
      const sizeKB = Math.round(bytes.byteLength / 1024)
      captions.push(`page ${n} (${sizeKB}KB)`)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'unknown error'
      return err(`Error: failed to fetch page ${n}: ${msg}`)
    }
  }

  return {
    content: `Fetched ${parts.length} page image(s): ${captions.join(', ')}. The PNGs follow as inline image parts — inspect them visually to answer the user's question.`,
    isError: false,
    extraParts: parts
  }
}

/**
 * Tool-call dispatcher. Args are expected pre-validated by Zod (see
 * `server/utils/agentic/functionTools.ts`); callers must not pass
 * unvalidated input. If args fail the Zod schema, the loop emits a
 * `functionResponse.isError` and this function is never called.
 *
 * `web_search` is NOT routed here — the main loop handles it via the
 * `webSearch` sub-call helper in `functionTools.ts` because it needs the
 * `AiClient` client and is async.
 */
/**
 * `message_to_user` — a short ephemeral answer for the person who ran
 * the session, rendered in the response panel above their prompt bar.
 *
 * Delivered through `session.deliverResponse` = the initiator-only
 * session channel (`agentic/sessionChannel.ts`), NOT awareness:
 * awareness reaches every participant of the document, and these
 * answers can summarise the initiator's other documents or knowledge.
 * One response per session, replaced not appended; `ts` lets the client
 * detect a fresh message even when the body repeats.
 *
 * The model's `output` is intentionally short — it just confirms the
 * message landed so the model doesn't try to repeat it.
 */
export async function handleMessageToUser(
  session: DocToolContext,
  input: MessageToUserInput
): Promise<ToolResult> {
  const isQuestion = input.is_question === true
  session.deliverResponse?.({ message: input.message, isQuestion, ts: Date.now() })

  // Persist a verbatim memory row so a follow-up prompt's
  // `<conversation_history>` block can show what the AI told the user.
  // Fire-and-forget — a memory hiccup never aborts the user-visible
  // message. Swallow errors at the boundary the same way activity
  // logging does.
  try {
    await appendAiMessage({
      docId: session.docId,
      userId: session.initiatorUserId,
      sessionId: session.sessionId,
      kind: 'message_to_user',
      body: { message: input.message, isQuestion }
    })
  } catch (e) {
    console.warn('[aiToolAdapter] message_to_user memory append failed:', e instanceof Error ? e.message : e)
  }

  return ok(
    isQuestion
      ? 'Question shown to user (sticky). Wait for their reply in a follow-up turn — do not send another question.'
      : 'Message shown to user (auto-collapses after 2s). Do not repeat it in a comment or in the document.'
  )
}

/**
 * Render an `ActivityEntry` row into a single human-/model-readable line.
 * Format: `[#id YYYY-MM-DDTHH:MM:SSZ action by Author] summary`. The
 * `id` is exposed so the model can chain into `replay`/`/restore`/diff
 * endpoints downstream if it needs to (those still go through their
 * own auth-checked HTTP routes — the AI doesn't get a direct restore
 * tool yet).
 *
 * Compaction rules per action:
 *   - edit: lines ±, word count
 *   - comment.*: short body preview
 *   - title.changed: from → to
 *   - ai.tool: the per-tool key (query / url / prompt / src / id)
 *   - restore: anchor activity id + frozen timestamp
 *   - join / leave / theme.changed: just the action label
 *
 * Exported for unit testing — every action branch + metadata shape
 * has rendering quirks and is the kind of code that silently
 * regresses without per-branch coverage.
 */
export function formatActivityRow(row: ActivityEntry): string {
  const ts = row.createdAt.toISOString()
  const who = row.userName ?? '(anonymous)'
  const head = `[#${row.id} ${ts} ${row.action} by ${who}]`
  const m = row.metadata as Record<string, unknown> | null
  const trim = (s: unknown, n: number) => (typeof s === 'string' ? s.slice(0, n) : '')

  switch (row.action) {
    case 'edit': {
      const parts: string[] = []
      if (typeof row.linesAdded === 'number' || typeof row.linesRemoved === 'number') {
        parts.push(`+${row.linesAdded ?? 0}/-${row.linesRemoved ?? 0} lines`)
      }
      if (typeof row.wordCount === 'number') parts.push(`${row.wordCount} words`)
      return `${head} ${parts.join(', ') || 'edit'}`
    }
    case 'comment.added':
    case 'comment.replied':
    case 'comment.resolved':
    case 'comment.reopened':
    case 'comment.deleted': {
      const preview = trim(m?.bodyPreview, 120)
      const id = trim(m?.commentId, 32)
      const idPart = id ? `comment_id=${id} ` : ''
      return `${head} ${idPart}body≈"${preview}"`
    }
    case 'title.changed':
      return `${head} from "${trim(m?.from, 80)}" → "${trim(m?.to, 80)}"`
    case 'theme.changed':
      return `${head} theme updated`
    case 'ai.tool': {
      const tool = trim(m?.tool, 40)
      switch (tool) {
        case 'web_search':
          return `${head} web_search query="${trim(m?.query, 120)}"`
        case 'fetch_url':
          return `${head} fetch_url url="${trim(m?.url, 200)}"`
        case 'generate_image':
          return `${head} generate_image prompt="${trim(m?.prompt, 120)}"`
        case 'view_image':
          return `${head} view_image src="${trim(m?.src, 200)}"`
        case 'search_knowledge':
          return `${head} search_knowledge query="${trim(m?.query, 120)}"`
        case 'get_knowledge_file':
          return `${head} get_knowledge_file knowledge_id=${trim(m?.knowledgeId, 64)}`
        default:
          return `${head} ai.tool ${tool || ''}`
      }
    }
    case 'restore': {
      const fromId = m && typeof m.restoredFromActivityId === 'number' ? m.restoredFromActivityId : null
      const fromTime = trim(m?.restoredFromTime, 32)
      const tail = fromTime ? ` (${fromTime})` : ''
      return `${head} restored to row #${fromId ?? '?'}${tail}`
    }
    case 'join':
    case 'leave':
      return `${head} ${row.action}`
    default:
      return head
  }
}

export async function handleSearchActivityLog(
  session: MetaToolContext,
  input: SearchActivityLogInput
): Promise<ToolResult> {
  // Parse + validate the optional ISO timestamps. Zod's `.datetime()`
  // already accepts only RFC 3339 / ISO 8601 — we still wrap in `new
  // Date` and check `isFinite` to reject anything pathological that
  // sneaks past the schema (e.g. year 0000).
  const parseTime = (s: string | undefined): Date | undefined => {
    if (!s) return undefined
    const d = new Date(s)
    if (!Number.isFinite(d.getTime())) return undefined
    return d
  }
  // The document's plan may limit how far back history goes
  // (`historyDays`); never search past that window.
  const cutoff = historyCutoff(await resolveDocPlan(session.docId))
  const requestedSince = parseTime(input.since)
  const since = cutoff && (!requestedSince || requestedSince < cutoff) ? cutoff : requestedSince
  const before = parseTime(input.before)

  let rows: ActivityEntry[]
  try {
    rows = await searchActivity(session.docId, {
      query: input.query,
      actions: input.actions,
      since,
      before,
      limit: input.limit ?? 20
    })
  } catch (e) {
    return err(`Error: search_activity_log failed: ${e instanceof Error ? e.message : 'unknown'}`)
  }

  if (rows.length === 0) {
    const filterDesc: string[] = []
    if (input.query) filterDesc.push(`query="${input.query}"`)
    if (input.actions?.length) filterDesc.push(`actions=[${input.actions.join(',')}]`)
    if (since) filterDesc.push(`since=${since.toISOString()}`)
    if (before) filterDesc.push(`before=${before.toISOString()}`)
    return ok(`No activity rows matched. Filters: ${filterDesc.join(', ') || '(none)'}.`)
  }

  // Returned in DESC-by-time order from the repo. Render preserves that
  // order so the model reads newest first — usually what it wants when
  // answering "the most recent / last X" style questions. The model can
  // re-issue with a tighter window if the first hit isn't the right one.
  const lines = rows.map(formatActivityRow)
  return ok(`Found ${rows.length} activity row${rows.length === 1 ? '' : 's'} (most recent first):\n${lines.join('\n')}`)
}

export async function executeFunctionByName(
  session: DocToolContext,
  name: string,
  args: unknown
): Promise<ToolResult> {
  const handler = TOOL_HANDLERS[name]
  if (!handler) {
    return err(`Error: Unsupported function "${name}". Supported: ${KNOWN_TOOL_NAMES.join(', ')}.`)
  }
  return handler(session, args)
}

// --- Knowledge tools -------------------------------------------------------

// Max chars returned to the model for `get_knowledge_file`. Matches the
// inline-rewrite window — enough to fit a ~15-20k-token document, which
// covers most workspace uploads. Anything larger gets truncated with a
// marker so the model knows to re-query via `search_knowledge` for the
// rest of the content.
const KNOWLEDGE_FILE_CHAR_CAP = 40_000
// We no longer floor by raw cosine similarity — the hybrid fusion can
// surface a low-sim chunk that's a strong BM25 match (e.g. "section 4.3"
// queries) and that's the point of having BM25. Drop obvious junk via
// the per-source candidate pool size instead.

/**
 * Per-call membership recheck for knowledge tools. AI sessions are
 * long-lived (up to 5 min hard deadline) and session.workspaceId is
 * resolved ONCE at /api/ai/prompt time. If an admin demotes the
 * initiator to viewer — or removes them from the workspace entirely —
 * mid-session, we'd otherwise keep serving knowledge until the loop
 * ends. One cheap getMemberRole call per tool invocation closes that
 * window at tool-call granularity.
 *
 * Viewer role still passes: viewers can read knowledge (same as the
 * REST list endpoint). We reject only on "no membership at all".
 */
async function verifyWorkspaceMembership(session: MetaToolContext): Promise<string | null> {
  if (!session.workspaceId) {
    return 'Error: this tool is only available for documents inside a workspace.'
  }
  const role = await getMemberRole(session.workspaceId, session.initiatorUserId)
  if (!role) {
    return 'Error: your membership in this workspace has been revoked. Knowledge tools are unavailable.'
  }
  return null
}

export async function handleSearchKnowledge(session: MetaToolContext, input: SearchKnowledgeInput): Promise<ToolResult> {
  const denied = await verifyWorkspaceMembership(session)
  if (denied) return err(denied)
  // verifyWorkspaceMembership guarantees workspaceId is non-null when
  // it returns null; TS can't follow that through the helper, hence
  // the local narrow.
  const workspaceId = session.workspaceId!
  const topK = input.top_k ?? 5

  session.updateStatus('tool', `Searching workspace knowledge for "${input.query.slice(0, 80)}"…`)

  let queryEmbedding: number[]
  try {
    await assertKnowledgeEmbeddingsReady()
    queryEmbedding = await embedQuery(input.query)
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error'
    return err(`Error: failed to embed query: ${msg}`)
  }

  const hits = await searchKnowledge({
    workspaceId,
    queryText: input.query,
    queryEmbedding,
    topK
  })

  if (hits.length === 0) {
    return ok('No relevant chunks found in the workspace knowledge base for this query. The knowledge base may not contain information on this topic — consider web_search, fetch_url, or asking the user.')
  }

  // Format: show semantic + lexical signals so the model can tell a
  // "paraphrased near-miss" (high sim, zero textScore) from an "exact
  // phrase hit" (low sim, high textScore). Keeps RRF transparent.
  const lines: string[] = [
    `Found ${hits.length} relevant chunk${hits.length === 1 ? '' : 's'}:`,
    ''
  ]
  for (const h of hits) {
    const sim = h.similarity > 0 ? h.similarity.toFixed(3) : '—'
    const bm25 = h.textScore > 0 ? h.textScore.toFixed(3) : '—'
    lines.push(
      `--- ${h.filename} (chunk ${h.chunkIndex}, semantic=${sim} lexical=${bm25}) ---`,
      h.content,
      ''
    )
  }
  return ok(lines.join('\n'))
}

export async function handleGetKnowledgeFile(session: MetaToolContext, input: GetKnowledgeFileInput): Promise<ToolResult> {
  const denied = await verifyWorkspaceMembership(session)
  if (denied) return err(denied)

  session.updateStatus('tool', `Reading knowledge file ${input.knowledge_id}…`)

  const row = await getKnowledgeWithMarkdown(input.knowledge_id)
  if (!row) {
    return err(`Error: knowledge_id "${input.knowledge_id}" not found. Use only ids from the <knowledge_files> block in the system prompt.`)
  }
  // Scope check — knowledge is workspace-scoped, session is workspace-scoped.
  if (row.workspaceId !== session.workspaceId) {
    return err(`Error: knowledge_id "${input.knowledge_id}" belongs to a different workspace.`)
  }
  if (row.status !== 'ready') {
    const errTail = row.errorMessage ? `: ${row.errorMessage}` : ''
    return err(`Error: knowledge file "${row.filename}" is currently in status "${row.status}"${errTail}.`)
  }
  if (!row.markdownCache) {
    return err(`Error: knowledge file "${row.filename}" has no cached content. Try search_knowledge instead.`)
  }

  const md = row.markdownCache
  if (md.length <= KNOWLEDGE_FILE_CHAR_CAP) {
    return ok(`# ${row.filename}\n\n${md}`)
  }
  const head = md.slice(0, KNOWLEDGE_FILE_CHAR_CAP)
  return ok(
    `# ${row.filename}\n\n${head}\n\n[… truncated at ${KNOWLEDGE_FILE_CHAR_CAP} characters of ${md.length}. Use search_knowledge with a targeted query to retrieve the remaining content. …]`
  )
}

// --- Comment tools -----------------------------------------------------------
//
// Comments live in a top-level `Y.Array<Y.Map>` named "comments" in the Y.Doc.
// Each comment map has: id, anchorStart, anchorEnd (base64 Y.RelativePositions),
// body, authorId (null for AI), authorName, authorAvatarSeed (anonymous authors
// only), createdAt, updatedAt,
// resolved, replies (nested Y.Array<Y.Map>).
//
// Anchors are encoded as base64 strings via Buffer (not btoa — server context).

function _toBase64Comment(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

function _fromBase64Comment(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, 'base64'))
}

/** Resolve a comment's anchor to { from, to } char offsets, or null (orphan). */
function resolveCommentAnchor(
  map: Y.Map<unknown>,
  ydoc: Y.Doc
): { from: number, to: number } | null {
  const startB64 = map.get('anchorStart')
  const endB64 = map.get('anchorEnd')
  if (typeof startB64 !== 'string' || typeof endB64 !== 'string') return null
  try {
    const startRel = Y.decodeRelativePosition(_fromBase64Comment(startB64))
    const endRel = Y.decodeRelativePosition(_fromBase64Comment(endB64))
    const startAbs = Y.createAbsolutePositionFromRelativePosition(startRel, ydoc)
    const endAbs = Y.createAbsolutePositionFromRelativePosition(endRel, ydoc)
    if (!startAbs || !endAbs || startAbs.index >= endAbs.index) return null
    return { from: startAbs.index, to: endAbs.index }
  } catch {
    return null
  }
}

/** Strip mention tokens to bare @Name for model-readable display. */
function stripMentions(body: string): string {
  return body.replace(/@\[([^\]]+)\]\(user:\d+\)/g, '@$1')
}

/** Format epoch-ms as a human-readable date string. */
function fmtDate(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
}

const COMMENT_ANCHOR_PREVIEW_MAX = 150

/** Build a human-readable anchor label from a resolved Y.js anchor. */
function formatAnchorLabel(
  anchor: { from: number, to: number } | null,
  fullText: string
): string {
  if (!anchor) return '[orphaned — anchored text was deleted]'
  const anchorText = fullText.slice(anchor.from, anchor.to)
  const preview = anchorText.length > COMMENT_ANCHOR_PREVIEW_MAX
    ? anchorText.slice(0, COMMENT_ANCHOR_PREVIEW_MAX) + '…'
    : anchorText
  // Convert char offsets to approximate line numbers for the model.
  const startLine = fullText.slice(0, anchor.from).split('\n').length
  const endLine = fullText.slice(0, anchor.to).split('\n').length
  return startLine === endLine
    ? `line ${startLine}: "${preview}"`
    : `lines ${startLine}–${endLine}: "${preview}"`
}

/** Format the four header lines (---, anchor, by, comment) for one thread. */
function formatThreadHeader(map: Y.Map<unknown>, fullText: string, ydoc: Y.Doc): string[] {
  const id = map.get('id') as string
  const body = typeof map.get('body') === 'string' ? stripMentions(map.get('body') as string) : ''
  const authorName = typeof map.get('authorName') === 'string' ? (map.get('authorName') as string) : 'Unknown'
  const createdAt = typeof map.get('createdAt') === 'number' ? (map.get('createdAt') as number) : 0
  const resolved = Boolean(map.get('resolved'))
  const anchorLabel = formatAnchorLabel(resolveCommentAnchor(map, ydoc), fullText)
  return [
    `--- Thread ${id}${resolved ? ' [RESOLVED]' : ''} ---`,
    `Anchor: ${anchorLabel}`,
    `By: ${authorName} at ${fmtDate(createdAt)}`,
    `Comment: ${body}`
  ]
}

/** Format the optional replies block (header + indented per-reply lines). */
function formatThreadReplies(map: Y.Map<unknown>): string[] {
  const repliesArr = map.get('replies')
  if (!(repliesArr instanceof Y.Array) || repliesArr.length === 0) return []
  const lines = [`Replies (${repliesArr.length}):`]
  for (let j = 0; j < repliesArr.length; j++) {
    const r = repliesArr.get(j)
    if (!(r instanceof Y.Map)) continue
    const rId = r.get('id') as string
    const rBody = typeof r.get('body') === 'string' ? stripMentions(r.get('body') as string) : ''
    const rAuthor = typeof r.get('authorName') === 'string' ? (r.get('authorName') as string) : 'Unknown'
    const rCreatedAt = typeof r.get('createdAt') === 'number' ? (r.get('createdAt') as number) : 0
    lines.push(`  [${rId}] ${rAuthor} at ${fmtDate(rCreatedAt)}: ${rBody}`)
  }
  return lines
}

export function handleReadComments(
  session: DocToolContext,
  _input: ReadCommentsInput
): ToolResult {
  const ycomments = session.ydoc.getArray<Y.Map<unknown>>('comments')
  if (ycomments.length === 0) return ok('No comments on this document.')

  const fullText = session.ytext.toJSON()
  const lines: string[] = [`Found ${ycomments.length} comment thread(s):\n`]
  for (let i = 0; i < ycomments.length; i++) {
    const map = ycomments.get(i)
    if (!(map instanceof Y.Map)) continue
    lines.push(
      ...formatThreadHeader(map, fullText, session.ydoc),
      ...formatThreadReplies(map),
      ''
    )
  }
  return ok(lines.join('\n'))
}

export async function handleCreateComment(
  session: DocToolContext,
  input: CreateCommentInput
): Promise<ToolResult> {
  if (input.end_line < input.start_line) {
    return err('Error: end_line must be >= start_line.')
  }

  const full = session.ytext.toJSON()
  const startChar = lineToCharOffset(full, input.start_line - 1)
  if (startChar === null) {
    return err(`Error: start_line ${input.start_line} is beyond the end of the document.`)
  }
  // end_line offset: start of the line AFTER end_line. Clamped to full.length
  // when end_line is the last line (lineToCharOffset returns null in that case).
  const rawEnd = lineToCharOffset(full, input.end_line)
  const endChar = rawEnd ?? full.length

  if (startChar >= endChar) {
    return err('Error: the specified line range resolves to an empty anchor. Use a range that covers at least one character.')
  }

  session.updateStatus('editing', 'Adding comment…')

  const startRel = Y.createRelativePositionFromTypeIndex(session.ytext, startChar, 0)
  const endRel = Y.createRelativePositionFromTypeIndex(session.ytext, endChar, -1)
  const anchorStart = _toBase64Comment(Y.encodeRelativePosition(startRel))
  const anchorEnd = _toBase64Comment(Y.encodeRelativePosition(endRel))

  const id = nanoid(12)
  const now = Date.now()
  const origin = `ai:assistant:${session.sessionId}`

  // Strip any `@ai` tokens the model may have written into its body —
  // otherwise its own comment would re-trigger the @ai-mention path the
  // next time the doc is loaded by a client. Belt-and-suspenders: the
  // server-side trigger guard ALSO rejects AI-authored messages, but
  // stripping here keeps the badge from rendering misleadingly in the UI.
  const safeBody = plainCommentText(stripAiMention(input.body))

  session.ydoc.transact(() => {
    const ycomments = session.ydoc.getArray<Y.Map<unknown>>('comments')
    const map = new Y.Map<unknown>()
    map.set('id', id)
    map.set('anchorStart', anchorStart)
    map.set('anchorEnd', anchorEnd)
    map.set('body', safeBody)
    map.set('authorId', null)
    map.set('authorName', AI_COMMENT_AUTHOR_NAME)
    map.set('authorAvatarSeed', null)
    map.set('createdAt', now)
    map.set('updatedAt', now)
    map.set('resolved', false)
    map.set('replies', new Y.Array())
    ycomments.push([map])
  }, origin)

  return ok(`Comment ${id} created on lines ${input.start_line}–${input.end_line}.`)
}

export function handleReplyToComment(
  session: DocToolContext,
  input: ReplyToCommentInput
): ToolResult {
  const ycomments = session.ydoc.getArray<Y.Map<unknown>>('comments')
  let parentMap: Y.Map<unknown> | null = null
  for (let i = 0; i < ycomments.length; i++) {
    const m = ycomments.get(i)
    if (m instanceof Y.Map && m.get('id') === input.comment_id) {
      parentMap = m
      break
    }
  }
  if (!parentMap) {
    return err(`Error: comment "${input.comment_id}" not found. Call read_comments to get current IDs.`)
  }

  const repliesArrRaw = parentMap.get('replies')
  if (!(repliesArrRaw instanceof Y.Array)) {
    return err(`Error: comment "${input.comment_id}" has a malformed replies array.`)
  }
  const repliesArr: Y.Array<Y.Map<unknown>> = repliesArrRaw
  const parent = parentMap

  session.updateStatus('editing', 'Adding reply…')

  const id = nanoid(12)
  const now = Date.now()
  const origin = `ai:assistant:${session.sessionId}`

  // Strip @ai from the reply body — same rationale as create_comment.
  const safeBody = plainCommentText(stripAiMention(input.body))

  session.ydoc.transact(() => {
    const reply = new Y.Map<unknown>()
    reply.set('id', id)
    reply.set('body', safeBody)
    reply.set('authorId', null)
    reply.set('authorName', AI_COMMENT_AUTHOR_NAME)
    reply.set('authorAvatarSeed', null)
    reply.set('createdAt', now)
    reply.set('updatedAt', now)
    repliesArr.push([reply])
    parent.set('updatedAt', now)
  }, origin)

  return ok(`Reply ${id} added to thread ${input.comment_id}.`)
}

export function handleResolveComment(
  session: DocToolContext,
  input: ResolveCommentInput
): ToolResult {
  const ycomments = session.ydoc.getArray<Y.Map<unknown>>('comments')
  for (let i = 0; i < ycomments.length; i++) {
    const m = ycomments.get(i)
    if (m instanceof Y.Map && m.get('id') === input.comment_id) {
      const origin = `ai:assistant:${session.sessionId}`
      session.ydoc.transact(() => {
        m.set('resolved', input.resolved)
        m.set('updatedAt', Date.now())
      }, origin)
      return ok(`Thread ${input.comment_id} marked as ${input.resolved ? 'resolved' : 'open'}.`)
    }
  }
  return err(`Error: comment "${input.comment_id}" not found. Call read_comments to get current IDs.`)
}

export async function handleDeleteComment(
  session: DocToolContext,
  input: DeleteCommentInput
): Promise<ToolResult> {
  const ycomments = session.ydoc.getArray<Y.Map<unknown>>('comments')

  // Determine if the initiator has doc management rights (cached once per call).
  let _canManage: boolean | null = null
  async function initiatorCanManage(): Promise<boolean> {
    _canManage ??= await canManageDoc(session.initiatorUserId, session.docId)
    return _canManage
  }

  for (let i = 0; i < ycomments.length; i++) {
    const m = ycomments.get(i)
    if (!(m instanceof Y.Map) || m.get('id') !== input.comment_id) continue
    return input.reply_id
      ? deleteReplyFromThread(session, m, input.comment_id, input.reply_id, initiatorCanManage)
      : deleteWholeThread(session, ycomments, i, m, input.comment_id, initiatorCanManage)
  }
  return err(`Error: comment "${input.comment_id}" not found. Call read_comments to get current IDs.`)
}

/**
 * Authorship gate for comment/reply deletion. markoto's own posts
 * (authorId=null + authorName='markoto', plus legacy 'AI Assistant'
 * from before the rename) and the initiator's own posts are always
 * deletable. Anything else falls through to the doc-manage right.
 */
function canDeleteEntry(map: Y.Map<unknown>, initiatorUserId: number): boolean {
  const authorId = map.get('authorId')
  if (isAiCommentAuthor(authorId, map.get('authorName'))) return true
  if (authorId === initiatorUserId) return true
  return false
}

async function deleteReplyFromThread(
  session: DocToolContext,
  parentMap: Y.Map<unknown>,
  commentId: string,
  replyId: string,
  initiatorCanManage: () => Promise<boolean>
): Promise<ToolResult> {
  const repliesArrRaw = parentMap.get('replies')
  if (!(repliesArrRaw instanceof Y.Array)) {
    return err(`Error: comment "${commentId}" has no replies.`)
  }
  const repliesArr: Y.Array<Y.Map<unknown>> = repliesArrRaw
  for (let j = 0; j < repliesArr.length; j++) {
    const r = repliesArr.get(j)
    if (!(r instanceof Y.Map) || r.get('id') !== replyId) continue
    if (!canDeleteEntry(r, session.initiatorUserId) && !(await initiatorCanManage())) {
      return err(`Error: cannot delete reply "${replyId}" — it was not authored by markoto or by you, and you do not have document management rights.`)
    }
    const origin = `ai:assistant:${session.sessionId}`
    session.ydoc.transact(() => {
      repliesArr.delete(j, 1)
      parentMap.set('updatedAt', Date.now())
    }, origin)
    return ok(`Reply ${replyId} deleted from thread ${commentId}.`)
  }
  return err(`Error: reply "${replyId}" not found in thread "${commentId}".`)
}

async function deleteWholeThread(
  session: DocToolContext,
  ycomments: Y.Array<Y.Map<unknown>>,
  index: number,
  parentMap: Y.Map<unknown>,
  commentId: string,
  initiatorCanManage: () => Promise<boolean>
): Promise<ToolResult> {
  if (!canDeleteEntry(parentMap, session.initiatorUserId) && !(await initiatorCanManage())) {
    return err(`Error: cannot delete thread "${commentId}" — it was not authored by markoto or by you, and you do not have document management rights.`)
  }
  const origin = `ai:assistant:${session.sessionId}`
  session.ydoc.transact(() => {
    ycomments.delete(index, 1)
  }, origin)
  return ok(`Thread ${commentId} deleted.`)
}
