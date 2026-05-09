// Translates the model's tool calls (Mistral via LiteLLM) into Y.Doc
// operations on a document shared via Hocuspocus. Edits appear live on
// every connected client.
//
// Entry point: `executeFunctionByName(session, name, args)` — dispatches a
// validated tool call to the right handler.

import type { AgenticPart as Part } from './agentic/aiTypes'
import { litellmCompletion } from './litellm/createCompletion'
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { nanoid } from 'nanoid'
import * as Y from 'yjs'
import * as Sentry from '@sentry/nuxt'
import type { AiSession } from './aiClient'
import { useLitellmForUser } from './litellmClient'
import { FEATURE_TAGS, featureMetadata } from './litellm/featureTags'
import type {
  ViewDocumentInput,
  ReplaceTextInput,
  InsertTextInput,
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
  ViewOtherDocumentInput,
  GetPageCountInput,
  ViewPagesInput,
  MessageToUserInput,
  SearchActivityLogInput
} from './agentic/functionTools'
import { renderDocument } from './renderClient'
import type { DocTheme } from '~~/shared/types/theme'
import { defaultTheme } from '~~/shared/utils/defaultTheme'
import { isValidTheme } from '~~/shared/utils/themeValidation'
import { THEME_PRESETS } from '~~/shared/utils/themePresets'
import { getDoc, getDocWithActorRole, updateDocMeta, listWorkspaceDocsWithOwnerFlag } from '../repos/documents'
import { decideTokenAccess } from '~~/shared/utils/docPermissions'
import { openTrustedCommentClient } from './commentsServerClient'
import { recordPending, markConfirmed } from '../repos/uploads'
import { getKnowledgeWithMarkdown, searchKnowledge } from '../repos/knowledge'
import { getMemberRole } from '../repos/workspaceMembers'
import {
  countThemesByUser,
  createTheme,
  getThemeById,
  listThemesByUser
} from '../repos/themes'
import { getWorkspace } from '../repos/workspaces'
import { canManageDoc } from './workspaceAccess'
import { embedQuery } from './embeddings'
import { appendAiMessage } from '../repos/aiSessionMessages'
import { searchActivity, type ActivityEntry } from '../repos/activity'
import { stripAiMention } from './agentic/commentTriggerPrompt'
import { assertSafeUrl } from './agentic/urlGuard'

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

function handleView(
  session: AiSession,
  input: { view_range?: [number, number], max_characters?: number }
): ToolResult {
  const fullText = session.ytext.toString()
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

function handleStrReplace(
  session: AiSession,
  input: { old_str: string, new_str: string }
): ToolResult {
  if (input.old_str.length === 0) {
    return err('Error: old_str cannot be empty (use `insert_text` for empty insertion)')
  }

  const full = session.ytext.toString()
  const { found, count } = findIndexOfOnlyMatch(full, input.old_str)

  if (count === 0) {
    return err('Error: No match found for old_str. The string must match exactly, including whitespace.')
  }
  if (count > 1) {
    return err(`Error: Found ${count} matches for old_str. Please provide more surrounding context to make a unique match.`)
  }

  session.updateStatus('editing', 'Applying edit…')

  const origin = `ai:assistant:${session.sessionId}`
  session.ydoc.transact(() => {
    session.ytext.delete(found, input.old_str.length)
    session.ytext.insert(found, input.new_str)
  }, origin)

  return ok('Successfully replaced text at exactly one location.')
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

function handleInsert(
  session: AiSession,
  input: { insert_line: number, insert_text: string }
): ToolResult {
  const full = session.ytext.toString()
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

  return ok('Successfully inserted text.')
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
 * Deep-merge a partial theme patch over a complete current theme. Only
 * two levels deep (top-level sections like `body`, sub-fields like
 * `body.size`) — the theme shape is flat enough that a generic deep
 * merge isn't worth it.
 */
/** @internal exported for unit tests; not part of the public API. */
export function mergeTheme(current: DocTheme, patch: Record<string, unknown>): DocTheme {
  const merged: Record<string, unknown> = { ...(current as unknown as Record<string, unknown>) }
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      merged[key] = {
        ...(current as unknown as Record<string, Record<string, unknown>>)[key],
        ...(value as Record<string, unknown>)
      }
    } else if (value !== undefined) {
      merged[key] = value
    }
  }
  return merged as unknown as DocTheme
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
  if (touched.length) parts.push(touched.join(', '))
  return parts.length ? parts.join(' + ') : '(no changes)'
}

async function handleUpdateTheme(
  session: AiSession,
  input: UpdateThemeInput
): Promise<ToolResult> {
  // Base theme selection. The four sources in priority order are
  // mutually exclusive — passing more than one is a usage error and
  // we surface that loudly so the model self-corrects rather than
  // silently picks one.
  //
  //   - `preset`                 — built-in id (markoto, modern, …)
  //   - `theme_id`               — initiator's own saved-theme id
  //   - `from_workspace_default` — workspace default (snapshot)
  //   - default                  — current ymeta.theme → DB → markoto
  //
  // Any other fields in the same call merge on top of whichever base
  // is chosen, so "preset academic with my brand red" is one call.
  const baseSources: string[] = []
  if (input.preset) baseSources.push('preset')
  if (input.theme_id) baseSources.push('theme_id')
  if (input.from_workspace_default) baseSources.push('from_workspace_default')
  if (baseSources.length > 1) {
    return err(`Error: pass only ONE of preset/theme_id/from_workspace_default; received: ${baseSources.join(', ')}.`)
  }

  let base: DocTheme
  if (input.preset) {
    const preset = THEME_PRESETS.find(p => p.id === input.preset)
    if (!preset) {
      // Should be unreachable — Zod enum restricts `preset` to known ids.
      return err(`Error: Unknown preset "${input.preset}".`)
    }
    base = preset.theme
  } else if (input.theme_id) {
    // Saved themes are per-user. We tie ownership to the SESSION
    // INITIATOR (the human who triggered the loop), not the AI's
    // synthetic principal — so an AI session can't access another
    // user's saved themes even if the caller hallucinates an id.
    const saved = await getThemeById(input.theme_id, session.initiatorUserId)
    if (!saved) {
      return err(`Error: saved theme "${input.theme_id}" not found. Call list_themes for valid ids.`)
    }
    base = saved.theme
  } else if (input.from_workspace_default) {
    if (!session.workspaceId) {
      return err('Error: from_workspace_default requires the document to be in a workspace.')
    }
    const ws = await getWorkspace(session.workspaceId)
    if (!ws?.defaultTheme) {
      return err('Error: this workspace has no default theme set. Ask an admin to set one, or pick a preset / saved theme instead.')
    }
    base = ws.defaultTheme
  } else {
    const fromYmeta = session.ymeta.get('theme')
    if (isValidTheme(fromYmeta)) {
      base = fromYmeta
    } else {
      const doc = await getDoc(session.docId)
      base = (doc?.theme && isValidTheme(doc.theme)) ? doc.theme : defaultTheme
    }
  }

  const coerced = coerceThemePatch(input)
  const merged = mergeTheme(base, coerced)

  if (!isValidTheme(merged)) {
    // Should never happen — the Zod schema's enums/ranges mirror
    // isValidTheme — but this is defence-in-depth so we never write
    // structurally invalid JSON into the DB or Y.Doc.
    return err('Error: merged theme failed validation. Try narrower changes.')
  }

  session.updateStatus('editing', 'Updating theme…')

  const origin = `ai:assistant:${session.sessionId}`
  session.ydoc.transact(() => {
    session.ymeta.set('theme', merged)
  }, origin)

  // Persist to DB so fresh visitors on a new socket see the new theme
  // during the window before y-postgresql replays Y.js state. Mirrors
  // the client-side `persistTheme` debounce in `useDocument.ts`.
  try {
    await updateDocMeta(session.docId, { theme: merged })
  } catch (e) {
    // DB write is best-effort — Y.js broadcast already landed the change
    // live to everyone. Worst case: a new visitor sees stale theme for
    // the few hundred ms between connect and first Y.js sync.
    console.warn(`[aiToolAdapter] theme DB persist failed for ${session.docId}:`, e)
    Sentry.captureException(e, {
      tags: { component: 'aiToolAdapter', event: 'theme_persist_failed', docId: session.docId }
    })
  }

  return ok(`Theme updated. Changed sections: ${summarizePatch(input)}. Changes are now live in the preview.`)
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
async function resolveCurrentTheme(session: AiSession): Promise<DocTheme> {
  const fromYmeta = session.ymeta.get('theme')
  if (isValidTheme(fromYmeta)) return fromYmeta
  const doc = await getDoc(session.docId)
  return (doc?.theme && isValidTheme(doc.theme)) ? doc.theme : defaultTheme
}

async function handleGetTheme(
  session: AiSession,
  _input: GetThemeInput
): Promise<ToolResult> {
  const theme = await resolveCurrentTheme(session)
  // Pretty-print so the model can read structure in the conversation
  // log. Stringification is bounded — DocTheme is small and flat (a
  // few hundred chars when minified).
  return ok(JSON.stringify(theme, null, 2))
}

async function handleListThemes(
  session: AiSession,
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

const MAX_THEMES_PER_USER = 20
const MAX_THEME_NAME_LENGTH = 80

async function handleSaveThemeAsPreset(
  session: AiSession,
  input: SaveThemeAsPresetInput
): Promise<ToolResult> {
  const name = input.name.trim()
  if (!name) return err('Error: name is required (1–80 chars).')
  if (name.length > MAX_THEME_NAME_LENGTH) {
    return err(`Error: name too long (max ${MAX_THEME_NAME_LENGTH}).`)
  }

  // Saved themes are personal — anonymous AI sessions (no logged-in
  // initiator) can't have saved themes. The `/api/ai/prompt` route
  // requires login, so this branch is defence-in-depth.
  if (!session.initiatorUserId) {
    return err('Error: saving a theme requires a logged-in user.')
  }

  // Cap check before write — same 20-per-user rule the REST endpoint
  // enforces. The cap is correctness-critical (storage growth), not a
  // rate limit, so we re-check rather than relying on a Valkey hint.
  const owned = await countThemesByUser(session.initiatorUserId)
  if (owned >= MAX_THEMES_PER_USER) {
    return err(`Error: you've reached the saved-theme limit (${MAX_THEMES_PER_USER}). Ask the user to delete an unused saved theme first.`)
  }

  const theme = await resolveCurrentTheme(session)

  session.updateStatus('tool', `Saving theme as "${name.slice(0, 40)}"…`)

  const themeId = nanoid(10)
  await createTheme({
    themeId,
    userId: session.initiatorUserId,
    name,
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
  const urlMatch = trimmed.match(/\/d\/([A-Za-z0-9_-]+)(?:[/?#]|$)/)
  if (urlMatch) return urlMatch[1] ?? null
  // Otherwise treat as a bare id only if the WHOLE string matches the
  // id alphabet (not "https://example.com" with no `/d/` segment).
  if (/^[A-Za-z0-9_-]+$/.test(trimmed)) return trimmed
  return null
}

async function handleListWorkspaceDocuments(
  session: AiSession,
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

const VIEW_OTHER_DOC_CHAR_CAP = 50_000

async function handleViewOtherDocument(
  session: AiSession,
  input: ViewOtherDocumentInput
): Promise<ToolResult> {
  const targetId = parseDocIdFromInput(input.doc_id)
  if (!targetId) {
    return err(`Error: could not extract a document id from "${input.doc_id.slice(0, 80)}". Pass either the bare id or a markoto URL like https://markoto.app/d/<id>.`)
  }
  if (targetId === session.docId) {
    return err('Error: this is the current document — call `view_document` instead.')
  }

  // Access decision mirrors `/api/docs/:id/token` exactly. The
  // initiator's permissions are the source of truth — never the AI's
  // synthetic principal — so the AI sees what the human would see by
  // pasting the URL into a browser, no more and no less.
  const ctx = await getDocWithActorRole(targetId, session.initiatorUserId)
  if (!ctx) {
    // 404-shape rather than "forbidden" — same exfil-resistant shape
    // the token endpoint uses. An attacker (or hallucinated id) can't
    // distinguish "doc doesn't exist" from "doc exists but you can't
    // see it".
    return err(`Error: document "${targetId}" not found, or you don't have access to it.`)
  }

  const decision = decideTokenAccess(
    {
      ownerId: ctx.ownerId,
      workspaceId: ctx.workspaceId,
      accessMode: ctx.accessMode
    },
    {
      userId: session.initiatorUserId,
      workspaceRole: ctx.workspaceRole
    }
  )
  if (decision.outcome !== 'allow') {
    if (decision.outcome === 'password-required') {
      // Workspace membership already bypassed the password gate in
      // `decideTokenAccess`, so this branch only fires for non-member
      // accessors of a password-protected doc. There's no way to ship
      // the password through the AI tool surface, so we surface it
      // distinctly (so the AI tells the user) rather than 404-masking.
      return err(`Error: document "${targetId}" is password-protected and you're not a workspace member. Ask the user to lift the password or share the doc differently.`)
    }
    // outcome === 'forbidden' (or any future deny shape). Surface as
    // 404-shape — an attacker who guesses a private doc's id shouldn't
    // learn that it exists. (Same anti-enumeration shape used at
    // /api/docs/:id/token's forbidden branch.)
    return err(`Error: document "${targetId}" not found, or you don't have access to it.`)
  }

  // Live read via Hocuspocus. Same trusted-client pattern the
  // comment-trigger endpoint uses for peek reads — opens just long
  // enough to get a synced ydoc, reads ytext, disconnects. Catches
  // mid-flight edits that haven't hit y-postgresql yet.
  session.updateStatus('tool', `Reading ${ctx.title || 'document'}…`)

  let body: string
  let client: Awaited<ReturnType<typeof openTrustedCommentClient>> | null = null
  try {
    client = await openTrustedCommentClient(
      targetId,
      `ai-cross-doc-read:${session.initiatorUserId}:${session.sessionId}`
    )
    const ytext = client.ydoc.getText('content')
    body = ytext.toString()
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'unknown error'
    return err(`Error: failed to read document "${targetId}" from sync server: ${msg}.`)
  } finally {
    if (client) {
      try {
        await client.destroy()
      } catch {
        /* best-effort cleanup */
      }
    }
  }

  // Apply view_range if the caller paged through. Same line-indexing
  // semantics as `view_document` — 1-indexed inclusive, end=-1 means
  // EOF. Validation already happened at the Zod schema (start >= 1,
  // end >= start || end === -1).
  const allLines = body.split('\n')
  let startLine = 1
  let endLine = allLines.length
  if (input.view_range) {
    const [s, e] = input.view_range
    startLine = s!
    endLine = e === -1 ? allLines.length : e!
  }
  // Slice; Zod guards bounds reasonably but we still clamp so a
  // huge end value doesn't crash anything downstream.
  const sliceStart = Math.max(0, startLine - 1)
  const sliceEnd = Math.min(allLines.length, endLine)
  const sliced = allLines.slice(sliceStart, sliceEnd)
  let formatted = sliced.map((line, i) => `${startLine + i}: ${line}`).join('\n')
  let truncated = false
  if (formatted.length > VIEW_OTHER_DOC_CHAR_CAP) {
    formatted = formatted.slice(0, VIEW_OTHER_DOC_CHAR_CAP)
    truncated = true
  }

  // Scope label tells the AI WHY it could read this — useful when
  // composing a quote ("From your workspace doc 'Q3 plan': …").
  const scope: string = ctx.ownerId === session.initiatorUserId
    ? 'self'
    : ctx.workspaceRole
      ? `workspace:${ctx.workspaceRole}`
      : ctx.accessMode === 'open-edit'
        ? 'public-edit'
        : ctx.accessMode === 'open-view'
          ? 'public-view'
          : 'shared'

  const meta = {
    doc_id: targetId,
    title: ctx.title,
    description: ctx.description,
    language: ctx.language,
    audience: ctx.audience,
    access_mode: ctx.accessMode,
    workspace_id: ctx.workspaceId,
    scope,
    line_count: allLines.length,
    showed_lines: { start: startLine, end: Math.min(allLines.length, endLine) },
    truncated_chars_at: truncated ? VIEW_OTHER_DOC_CHAR_CAP : null
  }

  // Body BEFORE meta in the formatted response so the model doesn't
  // have to scroll past the header to find the content. The trailing
  // metadata block is parseable JSON for fields the model wants to
  // reuse (title, scope, etc).
  const trailer = truncated
    ? '\n\n[Truncated at 50 000 chars — call view_other_document again with view_range to read more.]'
    : ''
  return ok(`${formatted}${trailer}\n\n--- metadata ---\n${JSON.stringify(meta, null, 2)}`)
}

// --- Set title ------------------------------------------------------------

async function handleSetTitle(
  session: AiSession,
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
  const match = src.match(/\/api\/files\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+\.[A-Za-z0-9]+)(?:$|[?#])/)
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

async function fetchExternalImage(url: string): Promise<{ bytes: Uint8Array, mimeType: string } | { error: string }> {
  // SSRF guard before any network IO. Rejects private CIDRs, metadata
  // IPs, link-local, non-HTTP schemes, and hostnames whose DNS records
  // resolve into private space. Critical here because `view_image`
  // takes ARBITRARY user-supplied URLs and we DO follow redirects —
  // the guard runs before the fetch so a malicious src is refused
  // upfront, and we don't pin the resolved IP onto the actual fetch
  // (limitation called out in urlGuard.ts).
  try {
    await assertSafeUrl(url)
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'URL refused' }
  }
  // 10s hard cap — an AI session that's already racing the 5-minute
  // deadline shouldn't spend a whole minute on one image fetch.
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 10_000)
  try {
    const resp = await fetch(url, { signal: ctrl.signal, redirect: 'follow' })
    if (!resp.ok) {
      return { error: `Remote returned HTTP ${resp.status}.` }
    }
    const mimeType = (resp.headers.get('content-type') || '').split(';')[0]!.trim().toLowerCase()
    if (!ALLOWED_IMAGE_TYPES.has(mimeType)) {
      return { error: `Remote returned content-type "${mimeType || '(none)'}". Allowed: ${[...ALLOWED_IMAGE_TYPES].join(', ')}.` }
    }
    const contentLength = Number(resp.headers.get('content-length') ?? '0')
    if (contentLength && contentLength > MAX_IMAGE_BYTES) {
      return { error: `Remote image is ${Math.round(contentLength / 1024)}KB, which exceeds the ${MAX_IMAGE_BYTES / (1024 * 1024)}MB limit.` }
    }
    const bytes = new Uint8Array(await resp.arrayBuffer())
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      return { error: `Remote image exceeded the ${MAX_IMAGE_BYTES / (1024 * 1024)}MB limit after fetch.` }
    }
    return { bytes, mimeType }
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error'
    return { error: `Failed to fetch image: ${msg}` }
  } finally {
    clearTimeout(timer)
  }
}

async function handleViewImage(
  session: AiSession,
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
  /** Output width in pixels. Default from runtimeConfig (1024 for BFL path). */
  width?: number
  /** Output height in pixels. Default from runtimeConfig (1024 for BFL path). */
  height?: number
  /** Per-user LiteLLM virtual-key bearer token (BFL path only). */
  virtualKey?: string
  /** Workspace context for spend-tagging (BFL path only). */
  workspaceId?: string | null
  /** Initiating user id for spend-tagging (BFL path only). */
  userId?: number | null
  /** Doc the image is being inserted into — drives doc-axis spend tag (BFL path only). */
  docId?: string | null
}

type ImageGenResult = { bytes: Uint8Array, mimeType: string } | { error: string }

/**
 * Generate an image from a text prompt. Routes through LiteLLM →
 * BFL FLUX.2 [pro] EU-pinned. 1024² default ($0.030/image). Honors
 * width/height (BFL meters by megapixel — non-square prices linearly).
 *
 * Returns raw bytes + MIME type, or an error string. The S3 upload + Y.js
 * insertion happens in `handleGenerateImage` and is shape-agnostic.
 */
async function generateImageBytes(
  prompt: string,
  _signal: AbortSignal,
  opts: ImageGenOpts = {}
): Promise<ImageGenResult> {
  return generateImageBytesBfl(prompt, opts)
}

// ─── BFL FLUX.2 [pro] path ──────────────────────────────────────────────

async function generateImageBytesBfl(
  prompt: string,
  opts: ImageGenOpts
): Promise<ImageGenResult> {
  if (!opts.virtualKey) {
    return { error: 'BFL image gen requires a per-user LiteLLM virtual key (Phase 6).' }
  }
  const config = useRuntimeConfig()
  const litellm = useLitellmForUser(opts.virtualKey)
  const model = config.litellm?.imageModel || 'flux-2-pro'
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
    if (msg.includes('budget_exceeded') || msg.includes('Budget has been exceeded')) {
      return { error: 'AI Points exhausted. Upgrade your plan at /pricing to continue.' }
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

async function handleGenerateImage(
  session: AiSession,
  input: GenerateImageInput
): Promise<ToolResult> {
  // Phase 6: no app-side interaction-charging. The BFL custom provider
  // bills the user's LiteLLM virtual key directly via the chat-completion
  // shape; budget_exceeded surfaces as a `LitellmBudgetExhausted` thrown
  // from `generateImageBytesBfl` (caught + translated to a tool-result
  // error string).
  session.updateStatus('tool', 'Generating image…')

  // 2. Generate. The 5-minute loop deadline is the effective cap — we
  //    don't thread a finer-grained signal here.
  const controller = new AbortController()
  const gen = await generateImageBytes(input.prompt, controller.signal, {
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
    const msg = e instanceof Error ? e.message : 'Unknown error'
    return err(`Error: failed to upload generated image: ${msg}`)
  }

  // 3. Record pending + confirm in the uploads table so orphan-cleanup
  //    doesn't reap it. Skip for anonymous-doc edge case (no FK target)
  //    — same behaviour as /api/upload/request. Best-effort: an S3
  //    object with no DB row still serves correctly; it just risks being
  //    cleaned up later if anonymous→owned promotion doesn't reconcile.
  const doc = await getDoc(session.docId)
  if (doc) {
    try {
      await recordPending({
        docId: session.docId,
        fileId: fileIdWithExt,
        uploaderId: session.initiatorUserId,
        contentType: gen.mimeType,
        sizeBytes: gen.bytes.byteLength,
        s3Key: key
      })
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
  return ok(`Generated and uploaded ${gen.mimeType} image (${sizeKB}KB). Markdown reference (copy verbatim into insert_text or replace_text): ${md}`)
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

async function handleGetPageCount(
  session: AiSession,
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

async function handleViewPages(
  session: AiSession,
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
    // Manifest's pageKeys is 1-indexed by `page-${n}.png` — derive the key
    // from the convention rather than trusting array order.
    const key = `renders/${session.docId}/${manifest.snapshotId}/page-${n}.png`
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
 * `message_to_user` — push a short ephemeral message into the AI's
 * awareness so the frontend's response panel renders it above the prompt
 * bar. Awareness already carries `user`, `aiSession`, `aiStatus`; we add
 * an `aiResponse` slot keyed by `ts` so clients can dedupe and trigger
 * the auto-collapse timer on appearance.
 *
 * Why awareness, not a DB row: this is ephemeral by design (one response
 * per session, replaced not appended). Awareness gives us multi-tab
 * delivery for free and dies with the session — no cleanup, no privacy
 * surface, no migrations. Phase 2 will add a DB-backed conversation
 * substrate for the AI's MEMORY of past turns; this surface stays
 * ephemeral.
 *
 * The model's `output` is intentionally short — it just confirms the
 * message landed so the model doesn't try to repeat it.
 */
async function handleMessageToUser(
  session: AiSession,
  input: MessageToUserInput
): Promise<ToolResult> {
  const isQuestion = input.is_question === true
  // ts uniquely identifies each response so clients can detect a fresh
  // message even when the body is identical to the previous one. Date.now()
  // resolution (ms) is plenty — the model is not racing itself.
  session.awareness.setLocalStateField('aiResponse', {
    message: input.message,
    isQuestion,
    ts: Date.now()
  })

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
      return `${head} ${id ? `comment_id=${id} ` : ''}body≈"${preview}"`
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
      return `${head} restored to row #${fromId ?? '?'}${fromTime ? ` (${fromTime})` : ''}`
    }
    case 'join':
    case 'leave':
      return `${head} ${row.action}`
    default:
      return head
  }
}

async function handleSearchActivityLog(
  session: AiSession,
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
  const since = parseTime(input.since)
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
  session: AiSession,
  name: string,
  args: unknown
): Promise<ToolResult> {
  switch (name) {
    case 'view_document': {
      const vr = (args as ViewDocumentInput).view_range
      // Zod schema guarantees exactly two integers when present (min(2).max(2)).
      // The `!` non-null assertions tell TS what the runtime validator already
      // enforces. Narrowing to a tuple keeps `handleView`'s signature tight.
      return handleView(session, {
        view_range: vr ? [vr[0]!, vr[1]!] : undefined
      })
    }
    case 'replace_text':
      return handleStrReplace(session, args as ReplaceTextInput)
    case 'insert_text':
      return handleInsert(session, args as InsertTextInput)
    case 'update_theme':
      return handleUpdateTheme(session, args as UpdateThemeInput)
    case 'get_theme':
      return handleGetTheme(session, args as GetThemeInput)
    case 'list_themes':
      return handleListThemes(session, args as ListThemesInput)
    case 'save_theme_as_preset':
      return handleSaveThemeAsPreset(session, args as SaveThemeAsPresetInput)
    case 'list_workspace_documents':
      return handleListWorkspaceDocuments(session, args as ListWorkspaceDocumentsInput)
    case 'view_other_document':
      return handleViewOtherDocument(session, args as ViewOtherDocumentInput)
    case 'set_title':
      return handleSetTitle(session, args as SetTitleInput)
    case 'view_image':
      return handleViewImage(session, args as ViewImageInput)
    case 'generate_image':
      return handleGenerateImage(session, args as GenerateImageInput)
    case 'get_page_count':
      return handleGetPageCount(session, args as GetPageCountInput)
    case 'view_pages':
      return handleViewPages(session, args as ViewPagesInput)
    case 'search_knowledge':
      return handleSearchKnowledge(session, args as SearchKnowledgeInput)
    case 'get_knowledge_file':
      return handleGetKnowledgeFile(session, args as GetKnowledgeFileInput)
    case 'read_comments':
      return handleReadComments(session, args as ReadCommentsInput)
    case 'create_comment':
      return handleCreateComment(session, args as CreateCommentInput)
    case 'reply_to_comment':
      return handleReplyToComment(session, args as ReplyToCommentInput)
    case 'resolve_comment':
      return handleResolveComment(session, args as ResolveCommentInput)
    case 'delete_comment':
      return handleDeleteComment(session, args as DeleteCommentInput)
    case 'message_to_user':
      return handleMessageToUser(session, args as MessageToUserInput)
    case 'search_activity_log':
      return handleSearchActivityLog(session, args as SearchActivityLogInput)
    default:
      return err(`Error: Unsupported function "${name}". Supported: view_document, replace_text, insert_text, web_search, update_theme, get_theme, list_themes, save_theme_as_preset, list_workspace_documents, view_other_document, set_title, view_image, generate_image, get_page_count, view_pages, search_knowledge, get_knowledge_file, read_comments, create_comment, reply_to_comment, resolve_comment, delete_comment, message_to_user, search_activity_log.`)
  }
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
async function verifyWorkspaceMembership(session: AiSession): Promise<string | null> {
  if (!session.workspaceId) {
    return 'Error: this tool is only available for documents inside a workspace.'
  }
  const role = await getMemberRole(session.workspaceId, session.initiatorUserId)
  if (!role) {
    return 'Error: your membership in this workspace has been revoked. Knowledge tools are unavailable.'
  }
  return null
}

async function handleSearchKnowledge(session: AiSession, input: SearchKnowledgeInput): Promise<ToolResult> {
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
    lines.push(`--- ${h.filename} (chunk ${h.chunkIndex}, semantic=${sim} lexical=${bm25}) ---`)
    lines.push(h.content)
    lines.push('')
  }
  return ok(lines.join('\n'))
}

async function handleGetKnowledgeFile(session: AiSession, input: GetKnowledgeFileInput): Promise<ToolResult> {
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
    return err(`Error: knowledge file "${row.filename}" is currently in status "${row.status}"${row.errorMessage ? `: ${row.errorMessage}` : ''}.`)
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
// body, authorId (null for AI), authorName, authorAvatar, createdAt, updatedAt,
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

function handleReadComments(
  session: AiSession,
  _input: ReadCommentsInput
): ToolResult {
  const ycomments = session.ydoc.getArray<Y.Map<unknown>>('comments')
  if (ycomments.length === 0) {
    return ok('No comments on this document.')
  }

  const fullText = session.ytext.toString()
  const ANCHOR_PREVIEW_MAX = 150

  const lines: string[] = [`Found ${ycomments.length} comment thread(s):\n`]
  for (let i = 0; i < ycomments.length; i++) {
    const map = ycomments.get(i)
    if (!(map instanceof Y.Map)) continue

    const id = map.get('id') as string
    const body = typeof map.get('body') === 'string' ? stripMentions(map.get('body') as string) : ''
    const authorName = typeof map.get('authorName') === 'string' ? (map.get('authorName') as string) : 'Unknown'
    const createdAt = typeof map.get('createdAt') === 'number' ? (map.get('createdAt') as number) : 0
    const resolved = Boolean(map.get('resolved'))

    const anchor = resolveCommentAnchor(map, session.ydoc)
    let anchorLabel: string
    if (anchor) {
      const anchorText = fullText.slice(anchor.from, anchor.to)
      const preview = anchorText.length > ANCHOR_PREVIEW_MAX
        ? anchorText.slice(0, ANCHOR_PREVIEW_MAX) + '…'
        : anchorText
      // Convert char offsets to approximate line numbers for the model
      const beforeStart = fullText.slice(0, anchor.from)
      const beforeEnd = fullText.slice(0, anchor.to)
      const startLine = beforeStart.split('\n').length
      const endLine = beforeEnd.split('\n').length
      anchorLabel = startLine === endLine
        ? `line ${startLine}: "${preview}"`
        : `lines ${startLine}–${endLine}: "${preview}"`
    } else {
      anchorLabel = '[orphaned — anchored text was deleted]'
    }

    lines.push(`--- Thread ${id}${resolved ? ' [RESOLVED]' : ''} ---`)
    lines.push(`Anchor: ${anchorLabel}`)
    lines.push(`By: ${authorName} at ${fmtDate(createdAt)}`)
    lines.push(`Comment: ${body}`)

    const repliesArr = map.get('replies')
    if (repliesArr instanceof Y.Array && repliesArr.length > 0) {
      lines.push(`Replies (${repliesArr.length}):`)
      for (let j = 0; j < repliesArr.length; j++) {
        const r = repliesArr.get(j)
        if (!(r instanceof Y.Map)) continue
        const rId = r.get('id') as string
        const rBody = typeof r.get('body') === 'string' ? stripMentions(r.get('body') as string) : ''
        const rAuthor = typeof r.get('authorName') === 'string' ? (r.get('authorName') as string) : 'Unknown'
        const rCreatedAt = typeof r.get('createdAt') === 'number' ? (r.get('createdAt') as number) : 0
        lines.push(`  [${rId}] ${rAuthor} at ${fmtDate(rCreatedAt)}: ${rBody}`)
      }
    }
    lines.push('')
  }

  return ok(lines.join('\n'))
}

async function handleCreateComment(
  session: AiSession,
  input: CreateCommentInput
): Promise<ToolResult> {
  if (input.end_line < input.start_line) {
    return err('Error: end_line must be >= start_line.')
  }

  const full = session.ytext.toString()
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
  const safeBody = stripAiMention(input.body)

  session.ydoc.transact(() => {
    const ycomments = session.ydoc.getArray<Y.Map<unknown>>('comments')
    const map = new Y.Map<unknown>()
    map.set('id', id)
    map.set('anchorStart', anchorStart)
    map.set('anchorEnd', anchorEnd)
    map.set('body', safeBody)
    map.set('authorId', null)
    map.set('authorName', 'markoto')
    map.set('authorAvatar', null)
    map.set('createdAt', now)
    map.set('updatedAt', now)
    map.set('resolved', false)
    map.set('replies', new Y.Array())
    ycomments.push([map])
  }, origin)

  return ok(`Comment ${id} created on lines ${input.start_line}–${input.end_line}.`)
}

function handleReplyToComment(
  session: AiSession,
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

  const repliesArr = parentMap.get('replies')
  if (!(repliesArr instanceof Y.Array)) {
    return err(`Error: comment "${input.comment_id}" has a malformed replies array.`)
  }

  session.updateStatus('editing', 'Adding reply…')

  const id = nanoid(12)
  const now = Date.now()
  const origin = `ai:assistant:${session.sessionId}`

  // Strip @ai from the reply body — same rationale as create_comment.
  const safeBody = stripAiMention(input.body)

  session.ydoc.transact(() => {
    const reply = new Y.Map<unknown>()
    reply.set('id', id)
    reply.set('body', safeBody)
    reply.set('authorId', null)
    reply.set('authorName', 'markoto')
    reply.set('authorAvatar', null)
    reply.set('createdAt', now)
    reply.set('updatedAt', now)
    ;(repliesArr as Y.Array<Y.Map<unknown>>).push([reply])
    parentMap!.set('updatedAt', now)
  }, origin)

  return ok(`Reply ${id} added to thread ${input.comment_id}.`)
}

function handleResolveComment(
  session: AiSession,
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

async function handleDeleteComment(
  session: AiSession,
  input: DeleteCommentInput
): Promise<ToolResult> {
  const ycomments = session.ydoc.getArray<Y.Map<unknown>>('comments')

  // Determine if the initiator has doc management rights (cached once per call).
  let _canManage: boolean | null = null
  async function initiatorCanManage(): Promise<boolean> {
    _canManage ??= await canManageDoc(session.initiatorUserId, session.docId)
    return _canManage
  }

  function canDeleteEntry(map: Y.Map<unknown>): boolean {
    const authorId = map.get('authorId')
    const authorName = map.get('authorName')
    // markoto's own comment: authorId=null and authorName='markoto'
    // (or legacy 'AI Assistant' from before the rename — keep for
    // backwards compat on existing comment threads).
    if (authorId === null && (authorName === 'markoto' || authorName === 'AI Assistant')) return true
    // Initiator's own comment
    if (authorId === session.initiatorUserId) return true
    return false
  }

  for (let i = 0; i < ycomments.length; i++) {
    const m = ycomments.get(i)
    if (!(m instanceof Y.Map) || m.get('id') !== input.comment_id) continue

    if (input.reply_id) {
      // Delete a specific reply
      const repliesArr = m.get('replies')
      if (!(repliesArr instanceof Y.Array)) {
        return err(`Error: comment "${input.comment_id}" has no replies.`)
      }
      for (let j = 0; j < repliesArr.length; j++) {
        const r = repliesArr.get(j)
        if (!(r instanceof Y.Map) || r.get('id') !== input.reply_id) continue
        if (!canDeleteEntry(r as Y.Map<unknown>) && !(await initiatorCanManage())) {
          return err(`Error: cannot delete reply "${input.reply_id}" — it was not authored by AI Assistant or by you, and you do not have document management rights.`)
        }
        const origin = `ai:assistant:${session.sessionId}`
        session.ydoc.transact(() => {
          ;(repliesArr as Y.Array<Y.Map<unknown>>).delete(j, 1)
          m.set('updatedAt', Date.now())
        }, origin)
        return ok(`Reply ${input.reply_id} deleted from thread ${input.comment_id}.`)
      }
      return err(`Error: reply "${input.reply_id}" not found in thread "${input.comment_id}".`)
    } else {
      // Delete the whole thread
      if (!canDeleteEntry(m) && !(await initiatorCanManage())) {
        return err(`Error: cannot delete thread "${input.comment_id}" — it was not authored by AI Assistant or by you, and you do not have document management rights.`)
      }
      const origin = `ai:assistant:${session.sessionId}`
      session.ydoc.transact(() => {
        ycomments.delete(i, 1)
      }, origin)
      return ok(`Thread ${input.comment_id} deleted.`)
    }
  }

  return err(`Error: comment "${input.comment_id}" not found. Call read_comments to get current IDs.`)
}
