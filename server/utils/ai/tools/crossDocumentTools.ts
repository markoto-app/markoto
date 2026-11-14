import { aiStatus } from '~~/shared/ai/statusSteps'
import { z } from 'zod'
import { defineMetaTool, toolError, toolOk, type ToolResult } from './toolDefinition'
import type { MetaToolContext } from '../../agentic/toolContext'
import { listWorkspaceDocsWithOwnerFlag, listOwnedByUser } from '../../../repos/documents'
import { getDocWithActorRole } from '../../access/docProof'
import { docStateOf, isEffectiveDocOwner, decideTokenAccess } from '~~/shared/utils/documents/docPermissions'
import { openTrustedCommentClient } from '../../documents/commentsServerClient'

// Cross-document reads: two tools that let the AI reach BEYOND the current document:
//
//   - list_workspace_documents: enumerate the OTHER docs in the
//     current session's workspace (current doc excluded). Useful for
//     "summarise everything in this workspace" or "find the doc
//     about X that I wrote last week".
//   - view_other_document: read the full body of any doc the user
//     could open in their browser. Same access surface: own private
//     docs, workspace member, public open-edit/open-view, password-
//     protected (workspace-membership bypass only, there's no way
//     to ship the password through the AI surface).
//
// Both tools share access semantics with the human session: the
// initiator's permissions, never the AI's synthetic principal.

const ListWorkspaceDocumentsArgs = z.object({}).describe('List all OTHER documents in the current document\'s workspace (the current document is excluded). Returns each doc\'s id, title, description, language, access_mode, last_active timestamp, and is_owner flag for the initiator. Errors if the document is not in a workspace. Use when the user asks to summarise the workspace, find a sibling doc by topic, or cross-reference content. After picking a candidate, call `view_other_document({ doc_id: ... })` to actually read it.')

const ListMyDocumentsArgs = z.object({
  limit: z.number().int().min(1).max(100).optional()
    .describe('Max documents to return. Default 25, cap 100. Sorted by last-active descending so the most recently touched docs come first.')
}).describe('List documents the initiator OWNS, across every workspace they participate in. Returns each doc\'s id, title, description, language, access_mode, workspace_id, word_count, and last_active timestamp. Use when the user references a doc by name without giving the id ("the Q3 retro doc", "my brand guidelines") so you can find the matching id, then call `view_other_document({ doc_id: ... })` to read it. Cross-workspace counterpart to `list_workspace_documents`, which is per-workspace and exposes shared (not just owned) docs.')

const ViewOtherDocumentArgs = z.object({
  doc_id: z.string().trim().min(1).max(2048)
    .describe('The target document id, OR a markoto URL containing it. Accepted shapes: bare id ("xyz123abc"), absolute URL ("https://markoto.app/d/xyz123abc", works for any markoto host), root-relative path ("/d/xyz123abc"). The id is extracted server-side; trailing slashes and query strings are tolerated. Pass the URL the user paste-shared verbatim, no need to parse it yourself.'),
  view_range: z.array(z.number().int()).min(2).max(2)
    .refine(([s, e]) => s !== undefined && (s >= 1) && (e === -1 || (e !== undefined && e >= s)), { message: 'view_range must be [start, end] where start >= 1 and end is either -1 (read to EOF) or >= start' })
    .optional()
    .describe('Optional 1-indexed inclusive line range [start, end]. Use -1 for end to read through to the end of the document. Default: full document, capped at the first 50 000 characters. Page through long docs by repeating the call with non-overlapping ranges.')
}).describe('Read another document\'s body + metadata. Permission check is the SAME as if the user opened the URL in their browser: their own docs, any doc in any workspace they belong to (any role, viewer is enough), and any anonymous open-edit / open-view doc. Private docs owned by other users return "not found." Password-protected docs are accessible only when the initiator is a member of that doc\'s workspace (workspace membership bypasses the password gate). Returns line-numbered body so you can quote / replace specific lines. The current document cannot be read this way, use `view_document` instead.')

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
 */
export function parseDocIdFromInput(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  // Try URL-shape match first. Doesn't matter whether the input has a
  // scheme: `/d/<id>` is the load-bearing piece.
  const urlMatch = /\/d\/([A-Za-z0-9_-]+)(?:[/?#]|$)/.exec(trimmed)
  if (urlMatch) return urlMatch[1] ?? null
  // Otherwise treat as a bare id only if the WHOLE string matches the
  // id alphabet (not "https://example.com" with no `/d/` segment).
  if (/^[A-Za-z0-9_-]+$/.test(trimmed)) return trimmed
  return null
}

async function handleListWorkspaceDocuments(
  session: MetaToolContext,
  _input: z.output<typeof ListWorkspaceDocumentsArgs>
): Promise<ToolResult> {
  // The membership proof, not the bare workspace id: a guest's session
  // carries the document's workspace id but no member proof.
  if (!session.workspaceId || !session.workspaceAccess) {
    return toolError('Error: list_workspace_documents requires the current document to be in a workspace.')
  }

  // Reuse the existing repo helper that powers /api/workspaces/:id,
  // identical fields, identical ownership flag computation, and the
  // same membership check happens before we get here (the AI session
  // belongs to a workspace member or it would have been rejected at
  // /api/ai/prompt time).
  const rows = await listWorkspaceDocsWithOwnerFlag(session.workspaceAccess)
  // Drop the current document from the list, the AI already has it
  // open, including it would be confusing and tempt redundant calls
  // to view_other_document on the same id it's editing.
  const visible = rows.filter(r => r.docId !== session.docId)

  if (visible.length === 0) {
    return toolOk('This workspace has no other documents (only the current one). Nothing to summarise or cross-reference.')
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
  return toolOk(JSON.stringify(payload, null, 2))
}

const LIST_MY_DOCUMENTS_DEFAULT_LIMIT = 25

async function handleListMyDocuments(
  session: MetaToolContext,
  input: z.output<typeof ListMyDocumentsArgs>
): Promise<ToolResult> {
  // Initiator-scoped: ownership is the truth source. The session's
  // synthetic principal is irrelevant here; we always look up against
  // the real human's id (same pattern handleListThemes,
  // handleSaveThemeAsPreset use).
  const limit = input.limit ?? LIST_MY_DOCUMENTS_DEFAULT_LIMIT
  const rows = await listOwnedByUser(session.self)
  const sliced = rows.slice(0, limit)

  if (sliced.length === 0) {
    return toolOk('You don\'t own any documents yet. Create one with `create_document` (when available), or open a public doc by URL via `view_other_document`.')
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
  return toolOk(JSON.stringify(payload, null, 2))
}

const VIEW_OTHER_DOC_CHAR_CAP = 50_000

async function handleViewOtherDocument(
  session: MetaToolContext,
  input: z.output<typeof ViewOtherDocumentArgs>
): Promise<ToolResult> {
  const targetId = parseDocIdFromInput(input.doc_id)
  if (!targetId) {
    return toolError(`Error: could not extract a document id from "${input.doc_id.slice(0, 80)}". Pass either the bare id or a markoto URL like https://markoto.app/d/<id>.`)
  }
  if (targetId === session.docId) {
    return toolError('Error: this is the current document, call `view_document` instead.')
  }

  const accessResult = await resolveCrossDocAccess(session, targetId)
  if (!accessResult.ok) return accessResult.error
  const ctx = accessResult.ctx

  // Live read via Hocuspocus. Same trusted-client pattern the
  // comment-trigger endpoint uses for peek reads, opens just long
  // enough to get a synced ydoc, reads ytext, disconnects. Catches
  // mid-flight edits that haven't been stored yet.
  session.updateStatus('tool', ctx.title ? aiStatus('readNamedDocument', { title: ctx.title }) : aiStatus('readOtherDocumentAny'))
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
    ? '\n\n[Truncated at 50 000 chars, call view_other_document again with view_range to read more.]'
    : ''
  // Readers know documents by their title, not their id: a summary that
  // cited `workspace doc "Kf50UWihca"` showed the raw id to the user.
  const citeTitle = (ctx.title || 'Untitled').replaceAll(']', ')').replaceAll('[', '(')
  const citation = `\n\nIf you mention or cite this document in the text, call it by its title, or link it exactly like this: [${citeTitle}](/d/${targetId}). Never write the bare document id, and never label the link with another document's title.`
  return toolOk(`${view.formatted}${trailer}${citation}\n\n--- metadata ---\n${JSON.stringify(meta, null, 2)}`)
}

type CrossDocCtx = NonNullable<Awaited<ReturnType<typeof getDocWithActorRole>>>
type CrossDocAccess = { ok: true, ctx: CrossDocCtx } | { ok: false, error: ToolResult }

/**
 * Mirror `/api/docs/:id/token` exactly. The initiator's permissions
 * are the source of truth, never the AI's synthetic principal, so
 * the AI sees what the human would see by pasting the URL into a
 * browser, no more and no less. 404-shapes mask "doc exists but
 * you can't see it" so a hallucinated id can't enumerate.
 *
 * Password-protected non-member access is surfaced distinctly (the
 * AI can tell the user) rather than 404-masking, there's no way to
 * ship the password through the AI tool surface, so the user has to
 * intervene.
 */
async function resolveCrossDocAccess(session: MetaToolContext, targetId: string): Promise<CrossDocAccess> {
  const ctx = await getDocWithActorRole(targetId, session.initiatorUserId)
  if (!ctx) {
    return { ok: false, error: toolError(`Error: document "${targetId}" not found, or you don't have access to it.`) }
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
    return { ok: false, error: toolError(`Error: document "${targetId}" is password-protected and you're not a workspace member. Ask the user to lift the password or share the doc differently.`) }
  }
  // outcome === 'forbidden' (or any future deny shape). Same
  // anti-enumeration shape used at /api/docs/:id/token's forbidden branch.
  return { ok: false, error: toolError(`Error: document "${targetId}" not found, or you don't have access to it.`) }
}

/**
 * Title of the document `docRef` (bare id or markoto URL) when `userId`
 * may open it: the same access decision `view_other_document` makes.
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
    return { ok: false, error: toolError(`Error: failed to read document "${targetId}" from sync server: ${msg}.`) }
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
 * Apply view_range. Same line-indexing semantics as `view_document`,
 * 1-indexed inclusive, end=-1 means EOF. Validation already happened
 * at the Zod schema (start >= 1, end >= start || end === -1). We
 * still clamp here so a huge end value doesn't crash anything
 * downstream, and we cap the formatted string at
 * `VIEW_OTHER_DOC_CHAR_CAP` chars.
 */
function applyViewRange(body: string, range: z.output<typeof ViewOtherDocumentArgs>['view_range']): ViewSlice {
  const allLines = body.split('\n')
  let startLine = 1
  let endLine = allLines.length
  if (range) {
    const [s = startLine, e = endLine] = range
    startLine = s
    endLine = e === -1 ? allLines.length : e
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
 * Tells the AI WHY it could read the doc, useful when composing a
 * quote ("From your workspace doc 'Q3 plan': …").
 */
function scopeLabelFor(ctx: CrossDocCtx, initiatorUserId: number): string {
  if (isEffectiveDocOwner(ctx, initiatorUserId)) return 'self'
  if (ctx.workspaceRole) return `workspace:${ctx.workspaceRole}`
  if (ctx.accessMode === 'open-edit') return 'public-edit'
  if (ctx.accessMode === 'open-view') return 'public-view'
  return 'shared'
}

export const listWorkspaceDocumentsTool = defineMetaTool({
  name: 'list_workspace_documents',
  description: 'List all OTHER documents in the current document\'s workspace (the current document itself is excluded). Returns id, title, description, language, access_mode, last_active, and is_owner per row. Errors if the current document is not in a workspace. Use to find sibling docs to summarise / cross-reference, or to discover what else lives in the workspace. Pair with `view_other_document` to read a specific one.',
  schema: ListWorkspaceDocumentsArgs,
  trustBoundary: 'confirm',
  handler: handleListWorkspaceDocuments
})

export const listMyDocumentsTool = defineMetaTool({
  name: 'list_my_documents',
  description: 'List documents the initiator OWNS, across every workspace they participate in (NOT scoped to the current doc\'s workspace). Returns id, title, description, language, access_mode, workspace_id, word_count, and last_active per row, sorted most-recent-first. Use when the user references a doc by name without giving the id ("the Q3 retro doc", "my brand guidelines doc") so you can find the matching id and then call `view_other_document({ doc_id: ... })`. Cross-workspace counterpart to `list_workspace_documents`.',
  schema: ListMyDocumentsArgs,
  trustBoundary: 'confirm',
  handler: handleListMyDocuments
})

export const viewOtherDocumentTool = defineMetaTool({
  name: 'view_other_document',
  description: 'Read the body and metadata of ANOTHER document, anything the user could open by URL: their own private docs, any doc in any workspace they belong to (viewer role is enough), public open-edit / open-view docs, or workspace docs (membership bypasses password gates). Accepts the doc_id directly OR a full markoto URL like https://markoto.app/d/xyz. Use when the user references a specific doc by id, by name in the workspace, or by URL ("can you summarise https://markoto.app/d/abc into this doc?"). The current document cannot be read this way, call `view_document` instead. Returns line-numbered body and full metadata so you can quote, link, or summarise. Long docs are capped at 50 000 chars; use the optional `view_range` to page through.',
  schema: ViewOtherDocumentArgs,
  trustBoundary: 'confirm',
  handler: handleViewOtherDocument
})
