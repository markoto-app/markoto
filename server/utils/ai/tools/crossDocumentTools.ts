import { aiStatus } from '~~/shared/ai/statusSteps'
import { z } from 'zod'
import { defineMetaTool, toolError, toolOk, type ToolResult } from './toolDefinition'
import type { MetaToolContext } from '../../agentic/toolContext'
import type { FolderScope } from '../../../repos/folders'
import { getDocWithActorRole } from '../../access/docProof'
import { docStateOf, isEffectiveDocOwner, decideTokenAccess } from '~~/shared/utils/documents/docPermissions'
import { openTrustedCommentClient } from '../../documents/commentsServerClient'
import { TOOL_RESULT_CHAR_CAP } from '../../agentic/limits'
import { boundedDocumentView } from './documentText'
import { parseDocIdFromInput } from './docRef'
import { listDocsPage, type DocListItem } from '../../explorer/docLists'
import { searchEverywhere } from '../../explorer/folderActions'
import { explorerErrorAsToolResult, folderPathsAcrossScopes, folderPathsOf, folderWorkspace, PERSONAL_SCOPE } from './folderTools'
import { documentSearchQuery } from '~~/shared/api/explorer'
import { splitSnippet } from '~~/shared/utils/documents/searchQuery'

// Cross-document reads: tools that let the AI reach BEYOND the current document:
//
//   - list_workspace_documents / list_my_documents: one page of a scope's
//     documents (the current document's workspace; the caller's personal
//     documents) in compact rows, paged with a cursor, so a workspace with
//     thousands of documents never lands in one tool result.
//   - search_documents: the explorer's full-text search over every
//     document the caller can reach (or one workspace / folder).
//   - view_other_document: read the body of any doc the user
//     could open in their browser. Same access surface: own private
//     docs, workspace member, public open-edit/open-view, password-
//     protected (workspace-membership bypass only, there's no way
//     to ship the password through the AI surface).
//
// All share access semantics with the human session: the initiator's
// permissions, never the AI's synthetic principal. Lists and search run the
// explorer's own code (`server/utils/explorer/`), so SSO and guest rules are
// those of the document list.

const LIST_DEFAULT_LIMIT = 50
const LIST_MAX_LIMIT = 200
const SEARCH_DEFAULT_LIMIT = 10
const SEARCH_MAX_LIMIT = 20
/** Descriptions in list rows are cut here: enough to recognise a document, not to read it. */
const LIST_DESCRIPTION_CHARS = 160

const pageArgs = {
  folder_id: z.string().trim().min(1).max(64).optional()
    .describe('Only documents filed directly in this folder (an id from list_folders), or "root" for documents in no folder. Omit for every document, in all folders.'),
  limit: z.number().int().min(1).max(LIST_MAX_LIMIT).optional()
    .describe(`Documents per page. Default ${LIST_DEFAULT_LIMIT}, at most ${LIST_MAX_LIMIT}. Most recently edited first.`),
  cursor: z.string().min(1).max(600).optional()
    .describe('next_cursor from the previous page, to continue the list. Omit for the first page.')
}

export const ListWorkspaceDocumentsArgs = z.object(pageArgs).describe('One page of the documents in the current document\'s workspace, most recently edited first: id, title, folder path, last edited, a short description. Errors if the document is not in a workspace.')

export const ListMyDocumentsArgs = z.object(pageArgs).describe('One page of your personal documents (owned by you, not in any workspace), most recently edited first: id, title, folder path, last edited, a short description.')

export const SearchDocumentsArgs = z.object({
  query: z.string().trim().min(1).max(200)
    .describe('Words to find in titles and text (prefix matching: "budg" finds "budget").'),
  workspace_id: z.string().trim().regex(/^[A-Za-z0-9_-]{1,64}$/).optional()
    .describe('Only this workspace, or "personal" for your personal documents. Omit to search everything you can open: personal documents, every workspace you are a member of, and documents shared with you.'),
  folder_id: z.string().trim().min(1).max(64).optional()
    .describe('Only this folder and its subfolders (an id from list_folders).'),
  limit: z.number().int().min(1).max(SEARCH_MAX_LIMIT).optional()
    .describe(`Results to return. Default ${SEARCH_DEFAULT_LIMIT}, at most ${SEARCH_MAX_LIMIT}. Best matches first.`)
}).describe('Full-text search over the documents you can open. Returns id, title, workspace, folder path and a snippet with the matched words in **bold**.')

const ViewOtherDocumentArgs = z.object({
  doc_id: z.string().trim().min(1).max(2048)
    .describe('The target document id, OR a markoto URL containing it. Accepted shapes: bare id ("xyz123abc"), absolute URL ("https://markoto.app/d/xyz123abc", works for any markoto host), root-relative path ("/d/xyz123abc"). The id is extracted server-side; trailing slashes and query strings are tolerated. Pass the URL the user paste-shared verbatim, no need to parse it yourself.'),
  view_range: z.array(z.number().int()).min(2).max(2)
    .refine(([s, e]) => s !== undefined && (s >= 1) && (e === -1 || (e !== undefined && e >= s)), { message: 'view_range must be [start, end] where start >= 1 and end is either -1 (read to EOF) or >= start' })
    .optional()
    .describe('Optional 1-indexed inclusive line range [start, end]. Use -1 for end to read through to the end of the document. Without it a short document is returned in full, a long one as a heading outline (with line ranges) plus its first lines.')
}).describe('Read another document\'s body + metadata. Permission check is the SAME as if the user opened the URL in their browser: their own docs, any doc in any workspace they belong to (any role, viewer is enough), and any anonymous open-edit / open-view doc. Private docs owned by other users return "not found." Password-protected docs are accessible only when the initiator is a member of that doc\'s workspace (workspace membership bypasses the password gate). Returns line-numbered body so you can quote / replace specific lines. The current document cannot be read this way, use `view_document` instead.')

function shortDescription(text: string): string | undefined {
  const t = text.trim()
  if (!t) return undefined
  return t.length > LIST_DESCRIPTION_CHARS ? `${t.slice(0, LIST_DESCRIPTION_CHARS - 1)}…` : t
}

/** One page of a scope's documents as the compact JSON both list tools return. */
async function listPage(session: MetaToolContext, scope: FolderScope, input: z.output<typeof ListMyDocumentsArgs>, header: Record<string, unknown>): Promise<ToolResult> {
  let page: Awaited<ReturnType<typeof listDocsPage>>
  try {
    page = await listDocsPage(session.self, scope, {
      folder: input.folder_id ?? 'all',
      sort: 'updated',
      cursor: input.cursor,
      limit: input.limit ?? LIST_DEFAULT_LIMIT
    })
  } catch (e) {
    return explorerErrorAsToolResult(e)
  }
  const pathOf = await folderPathsOf(scope)
  const row = (d: DocListItem) => ({
    doc_id: d.docId,
    title: d.title,
    folder: pathOf(d.folderId),
    folder_id: d.folderId,
    last_edited: d.updatedAt,
    description: shortDescription(d.description),
    // The model already has the current document open; marking it saves a
    // redundant view_other_document on the id it is editing.
    ...(d.docId === session.docId ? { current_document: true } : {})
  })
  return toolOk(JSON.stringify({
    ...header,
    total: page.total,
    returned: page.items.length,
    documents: page.items.map(row),
    next_cursor: page.nextCursor,
    notes: [
      page.nextCursor ? 'More documents: call again with cursor = next_cursor.' : null,
      'Pass doc_id to view_other_document to read one. folder is null for documents in no folder.',
      'To find a document by its content or name, search_documents is faster than paging.'
    ].filter(Boolean)
  }, null, 2))
}

async function handleListWorkspaceDocuments(
  session: MetaToolContext,
  input: z.output<typeof ListWorkspaceDocumentsArgs>
): Promise<ToolResult> {
  // The membership proof, not the bare workspace id: a guest's session
  // carries the document's workspace id but no member proof.
  if (!session.workspaceId || !session.workspaceAccess) {
    return toolError('Error: list_workspace_documents requires the current document to be in a workspace.')
  }
  return listPage(session, session.workspaceAccess, input, { workspace_id: session.workspaceId })
}

async function handleListMyDocuments(
  session: MetaToolContext,
  input: z.output<typeof ListMyDocumentsArgs>
): Promise<ToolResult> {
  // Personal documents only (the explorer's "My documents"). Documents the
  // caller owns inside a workspace belong to that workspace's list; the
  // model reaches them with list_workspace_documents or search_documents.
  return listPage(session, session.self, input, { scope: 'personal' })
}

/** A snippet with its match markers (invisible separators) turned into Markdown bold the model reads. */
function readableSnippet(snippet: string): string {
  return splitSnippet(snippet).map(p => (p.match ? `**${p.text}**` : p.text)).join('')
}

async function handleSearchDocuments(
  session: MetaToolContext,
  input: z.output<typeof SearchDocumentsArgs>
): Promise<ToolResult> {
  let scope = 'all'
  if (input.workspace_id === PERSONAL_SCOPE) scope = 'personal'
  else if (input.workspace_id) scope = `ws:${input.workspace_id}`
  else if (input.folder_id) {
    // A folder names its scope; the explorer's search wants both.
    const ws = await folderWorkspace(session.initiatorUserId, input.folder_id)
    if (ws === undefined) return toolError(`Error: folder "${input.folder_id}" not found.`)
    scope = ws === null ? 'personal' : `ws:${ws}`
  }
  const query = documentSearchQuery.safeParse({ q: input.query, scope, folder: input.folder_id, limit: input.limit ?? SEARCH_DEFAULT_LIMIT, offset: 0 })
  if (!query.success) return toolError('Error: invalid workspace_id or folder_id.')
  let found: Awaited<ReturnType<typeof searchEverywhere>>
  try {
    found = await searchEverywhere(session.self, query.data)
  } catch (e) {
    return explorerErrorAsToolResult(e)
  }
  if (found.results.length === 0) {
    return toolOk(`No documents match "${input.query}". Try other or fewer words, or list documents with list_workspace_documents / list_my_documents.`)
  }
  const pathOf = folderPathsAcrossScopes(session)
  const results = await Promise.all(found.results.map(async r => ({
    doc_id: r.docId,
    title: r.title,
    workspace: r.workspaceId ? { id: r.workspaceId, name: r.workspaceName } : null,
    folder: await pathOf(r.workspaceId, r.folderId),
    last_edited: r.updatedAt,
    snippet: readableSnippet(r.snippet)
  })))
  return toolOk(JSON.stringify({
    query: input.query,
    results,
    has_more: found.hasMore,
    notes: [
      'workspace is null for personal documents. Pass doc_id to view_other_document to read one.',
      found.hasMore ? 'More matches exist: narrow the query, or pass workspace_id / folder_id.' : null
    ].filter(Boolean)
  }, null, 2))
}

/**
 * Room the document body gets in a view_other_document result: the loop's
 * result cap minus the metadata and citation blocks that follow it.
 */
const VIEW_OTHER_DOC_CHAR_BUDGET = TOOL_RESULT_CHAR_CAP - 3_000

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

  const [rangeStart, rangeEnd] = input.view_range ?? []
  const range = rangeStart !== undefined && rangeEnd !== undefined ? [rangeStart, rangeEnd] as const : undefined
  const view = boundedDocumentView(bodyResult.body, range, VIEW_OTHER_DOC_CHAR_BUDGET, `view_other_document (doc_id "${targetId}")`)
  const meta = {
    doc_id: targetId,
    title: ctx.title,
    description: ctx.description,
    language: ctx.language,
    audience: ctx.audience,
    access_mode: ctx.accessMode,
    workspace_id: ctx.workspaceId,
    scope: scopeLabelFor(ctx, session.initiatorUserId),
    line_count: bodyResult.body.split('\n').length
  }

  // Body BEFORE meta in the formatted response so the model doesn't
  // have to scroll past the header to find the content. The trailing
  // metadata block is parseable JSON for fields the model wants to
  // reuse (title, scope, etc).
  // Readers know documents by their title, not their id: a summary that
  // cited `workspace doc "Kf50UWihca"` showed the raw id to the user.
  const citeTitle = (ctx.title || 'Untitled').replaceAll(']', ')').replaceAll('[', '(')
  const citation = `\n\nIf you mention or cite this document in the text, call it by its title, or link it exactly like this: [${citeTitle}](/d/${targetId}). Never write the bare document id, and never label the link with another document's title.`
  return toolOk(`${view}${citation}\n\n--- metadata ---\n${JSON.stringify(meta, null, 2)}`)
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
  description: 'List the documents in the current document\'s workspace, one page at a time (default 50, most recently edited first): id, title, folder path, last edited and a short description per row, plus total and next_cursor. Narrow to one folder with folder_id (from list_folders). Errors if the current document is not in a workspace. To find a document by name or content, prefer search_documents. Pair with `view_other_document` to read one.',
  schema: ListWorkspaceDocumentsArgs,
  trustBoundary: 'confirm',
  handler: handleListWorkspaceDocuments
})

export const listMyDocumentsTool = defineMetaTool({
  name: 'list_my_documents',
  description: 'List your personal documents (owned by you, not in any workspace), one page at a time (default 50, most recently edited first): id, title, folder path, last edited and a short description per row, plus total and next_cursor. Narrow to one folder with folder_id. Documents in workspaces are not listed here: use list_workspace_documents or search_documents. Pair with `view_other_document` to read one.',
  schema: ListMyDocumentsArgs,
  trustBoundary: 'confirm',
  handler: handleListMyDocuments
})

export const searchDocumentsTool = defineMetaTool({
  name: 'search_documents',
  description: 'Search the titles and text of every document you can open (personal, every workspace you belong to, shared with you), or only one workspace (workspace_id, "personal") or folder (folder_id, with its subfolders). Returns up to 20 best matches: id, title, workspace, folder path, last edited and a snippet with the matched words in **bold**. Use when the user names a document ("the Q3 retro", "our brand guidelines") or a topic without giving its id, then call `view_other_document` to read it.',
  schema: SearchDocumentsArgs,
  trustBoundary: 'confirm',
  handler: handleSearchDocuments
})

export const viewOtherDocumentTool = defineMetaTool({
  name: 'view_other_document',
  description: 'Read the body and metadata of ANOTHER document, anything the user could open by URL: their own private docs, any doc in any workspace they belong to (viewer role is enough), public open-edit / open-view docs, or workspace docs (membership bypasses password gates). Accepts the doc_id directly OR a full markoto URL like https://markoto.app/d/xyz. Use when the user references a specific doc by id, by name in the workspace, or by URL ("can you summarise https://markoto.app/d/abc into this doc?"). The current document cannot be read this way, call `view_document` instead. Returns line-numbered body and full metadata so you can quote, link, or summarise. A long document returns its heading outline with line ranges plus the first lines; read the parts you need with `view_range`.',
  schema: ViewOtherDocumentArgs,
  trustBoundary: 'confirm',
  handler: handleViewOtherDocument
})
