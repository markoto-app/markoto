import type { DocToolContext, MetaToolContext } from './toolContext'
import type { ToolResult } from '../aiToolAdapter'
import {
  handleView,
  handleStrReplace,
  handleInsert,
  handleUpdateTheme,
  handleGetTheme,
  handleListThemes,
  handleSaveThemeAsPreset,
  handleListWorkspaceDocuments,
  handleViewOtherDocument,
  handleSetTitle,
  handleViewImage,
  handleGenerateImage,
  handleGetPageCount,
  handleViewPages,
  handleSearchKnowledge,
  handleGetKnowledgeFile,
  handleReadComments,
  handleCreateComment,
  handleReplyToComment,
  handleResolveComment,
  handleDeleteComment,
  handleMessageToUser,
  handleSearchActivityLog,
  handleListMyDocuments,
  handleCreateDocument,
  handleDuplicateDocument,
  handleExportDocumentAsMarkdown
} from '../aiToolAdapter'
import { webSearch, fetchUrl } from './functionTools'
import type {
  ViewDocumentInput,
  ReplaceTextInput,
  InsertTextInput,
  UpdateThemeInput,
  GetThemeInput,
  ListThemesInput,
  SaveThemeAsPresetInput,
  ListWorkspaceDocumentsInput,
  ListMyDocumentsInput,
  CreateDocumentInput,
  DuplicateDocumentInput,
  ExportDocumentAsMarkdownInput,
  ViewOtherDocumentInput,
  SetTitleInput,
  ViewImageInput,
  GenerateImageInput,
  GetPageCountInput,
  ViewPagesInput,
  SearchKnowledgeInput,
  GetKnowledgeFileInput,
  ReadCommentsInput,
  CreateCommentInput,
  ReplyToCommentInput,
  ResolveCommentInput,
  DeleteCommentInput,
  MessageToUserInput,
  SearchActivityLogInput
} from './functionTools'

// Loop-agnostic dispatch tables for the AI tool handlers. Two
// separate tables — one per context tier — so the MCP wrapper
// builders can type-constrain which names they accept:
//
//   buildDocBoundTool       → only DocToolName keys
//   buildWorkspaceBoundTool → only MetaToolName keys
//   buildUserOnlyTool       → only MetaToolName keys
//
// Misuse becomes a compile error: `buildWorkspaceBoundTool({ name:
// 'replace_text' })` fails because `'replace_text'` is a key in
// DOC_TOOL_HANDLERS, not META_TOOL_HANDLERS.
//
// The combined `TOOL_HANDLERS` map is what `executeFunctionByName`
// dispatches against — the loop's full `AiSession` (DocToolContext)
// is acceptable to both DOC and META handlers because DocToolContext
// extends MetaToolContext.

type DocHandlerFn = (ctx: DocToolContext, args: unknown) => ToolResult | Promise<ToolResult>
type MetaHandlerFn = (ctx: MetaToolContext, args: unknown) => ToolResult | Promise<ToolResult>

/**
 * Handlers that read or mutate Y.js state (ydoc/ytext/ymeta) OR
 * broadcast via the doc's awareness channel. MCP wrappers using
 * `buildDocBoundTool` route into here.
 */
export const DOC_TOOL_HANDLERS = Object.freeze({
  view_document: (ctx, args) => {
    const vr = (args as ViewDocumentInput).view_range
    return handleView(ctx, {
      view_range: vr ? [vr[0]!, vr[1]!] : undefined
    })
  },
  replace_text: (ctx, args) => handleStrReplace(ctx, args as ReplaceTextInput),
  insert_text: (ctx, args) => handleInsert(ctx, args as InsertTextInput),
  update_theme: (ctx, args) => handleUpdateTheme(ctx, args as UpdateThemeInput),
  get_theme: (ctx, args) => handleGetTheme(ctx, args as GetThemeInput),
  save_theme_as_preset: (ctx, args) => handleSaveThemeAsPreset(ctx, args as SaveThemeAsPresetInput),
  set_title: (ctx, args) => handleSetTitle(ctx, args as SetTitleInput),
  read_comments: (ctx, args) => handleReadComments(ctx, args as ReadCommentsInput),
  create_comment: (ctx, args) => handleCreateComment(ctx, args as CreateCommentInput),
  reply_to_comment: (ctx, args) => handleReplyToComment(ctx, args as ReplyToCommentInput),
  resolve_comment: (ctx, args) => handleResolveComment(ctx, args as ResolveCommentInput),
  delete_comment: (ctx, args) => handleDeleteComment(ctx, args as DeleteCommentInput),
  message_to_user: (ctx, args) => handleMessageToUser(ctx, args as MessageToUserInput),
  // Reads ytext directly — DOC-bound. Pure read; no mutation.
  export_document_as_markdown: (ctx, args) => handleExportDocumentAsMarkdown(ctx, args as ExportDocumentAsMarkdownInput)
} as const satisfies Record<string, DocHandlerFn>)

/**
 * Handlers that operate on DB rows + external APIs only. No Y.js
 * handles touched. MCP wrappers using `buildWorkspaceBoundTool` or
 * `buildUserOnlyTool` route into here.
 */
export const META_TOOL_HANDLERS = Object.freeze({
  list_themes: (ctx, args) => handleListThemes(ctx, args as ListThemesInput),
  list_workspace_documents: (ctx, args) => handleListWorkspaceDocuments(ctx, args as ListWorkspaceDocumentsInput),
  list_my_documents: (ctx, args) => handleListMyDocuments(ctx, args as ListMyDocumentsInput),
  // Phase 4 host-style tools. Both META — no current-doc context
  // needed, the tool args carry their own doc references.
  create_document: (ctx, args) => handleCreateDocument(ctx, args as CreateDocumentInput),
  duplicate_document: (ctx, args) => handleDuplicateDocument(ctx, args as DuplicateDocumentInput),
  view_other_document: (ctx, args) => handleViewOtherDocument(ctx, args as ViewOtherDocumentInput),
  view_image: (ctx, args) => handleViewImage(ctx, args as ViewImageInput),
  generate_image: (ctx, args) => handleGenerateImage(ctx, args as GenerateImageInput),
  get_page_count: (ctx, args) => handleGetPageCount(ctx, args as GetPageCountInput),
  view_pages: (ctx, args) => handleViewPages(ctx, args as ViewPagesInput),
  search_knowledge: (ctx, args) => handleSearchKnowledge(ctx, args as SearchKnowledgeInput),
  get_knowledge_file: (ctx, args) => handleGetKnowledgeFile(ctx, args as GetKnowledgeFileInput),
  search_activity_log: (ctx, args) => handleSearchActivityLog(ctx, args as SearchActivityLogInput),

  // `web_search` and `fetch_url` are called directly from runLoop in
  // the in-app loop (they have a 2-call shape that needs the loop's
  // abort signal + spend-tag context). The bridge below adapts them to
  // the (ctx, args) signature so MCP wrappers + the dispatch table can
  // call them through the same surface as every other tool. The loop
  // continues to call them directly for now.
  web_search: async (ctx, args): Promise<ToolResult> => {
    const { query } = args as { query: string }
    const result = await webSearch(undefined, '', query, neverAbortSignal(), {
      workspaceId: ctx.workspaceId,
      userId: ctx.initiatorUserId,
      docId: ctx.docId,
      // Authenticate the synthesis with the caller's virtual key and run
      // it on their chat provider (BYOK), matching the in-app loop.
      virtualKey: ctx.virtualKey,
      chatProvider: ctx.aiProviders.chat
    })
    return { content: result.text, isError: false }
  },
  fetch_url: async (ctx, args): Promise<ToolResult> => {
    const { url } = args as { url: string }
    const result = await fetchUrl(undefined, '', url, neverAbortSignal(), {
      workspaceId: ctx.workspaceId,
      userId: ctx.initiatorUserId,
      docId: ctx.docId,
      virtualKey: ctx.virtualKey,
      chatProvider: ctx.aiProviders.chat
    })
    return { content: result.text, isError: false }
  }
} as const satisfies Record<string, MetaHandlerFn>)

/**
 * Combined dispatch — what `executeFunctionByName` looks up against.
 * Doc handlers happily accept the loop's full `AiSession` (a subtype
 * of DocToolContext); meta handlers also accept it (DocToolContext is
 * structurally a superset of MetaToolContext).
 */
export const TOOL_HANDLERS: Readonly<Record<string, (ctx: DocToolContext, args: unknown) => ToolResult | Promise<ToolResult>>>
  = Object.freeze({ ...DOC_TOOL_HANDLERS, ...META_TOOL_HANDLERS })

export type DocToolName = keyof typeof DOC_TOOL_HANDLERS
export type MetaToolName = keyof typeof META_TOOL_HANDLERS
export type ToolName = DocToolName | MetaToolName

/** Sorted list of every tool name. Used by `executeFunctionByName` to
 *  generate the "Supported: ..." error for unknown names + by tests
 *  that enumerate the registry. */
export const KNOWN_TOOL_NAMES: readonly string[] = Object.freeze(
  [...Object.keys(DOC_TOOL_HANDLERS), ...Object.keys(META_TOOL_HANDLERS)].sort((a, b) => a.localeCompare(b))
)

// MCP tool calls don't have an in-flight abort signal (no equivalent
// of the loop's 5-min deadline). The toolkit may add one in a future
// version; until then, web_search / fetch_url get a never-aborts
// signal and rely on the underlying Jina/Mistral SDKs' own timeouts.
function neverAbortSignal(): AbortSignal {
  return new AbortController().signal
}
