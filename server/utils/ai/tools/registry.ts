import type { ZodType } from 'zod'
import type { AgenticFunctionDeclaration as FunctionDeclaration } from '../../agentic/aiTypes'
import type { DocToolContext, MetaToolContext } from '../../agentic/toolContext'
import { toFunctionDeclaration, toolError, type ToolDefinition, type ToolResult } from './toolDefinition'
import { insertTextTool, replaceTextTool, setTitleTool, viewDocumentTool } from './documentTools'
import { getThemeTool, listThemesTool, saveThemeAsPresetTool, updateThemeTool } from './themeTools'
import { listMyDocumentsTool, listWorkspaceDocumentsTool, searchDocumentsTool, viewOtherDocumentTool } from './crossDocumentTools'
import { createFolderTool, listFoldersTool, moveDocumentTool } from './folderTools'
import { createDocumentTool, duplicateDocumentTool, exportDocumentAsMarkdownTool } from './libraryTools'
import { generateImageTool, viewImageTool } from './imageTools'
import { getPageCountTool, viewPagesTool } from './renderTools'
import { fetchUrlTool, webSearchTool } from './webResearchTools'
import { createCommentTool, deleteCommentTool, readCommentsTool, replyToCommentTool, resolveCommentTool } from './commentTools'
import { messageToUserTool } from './messageTools'
import { searchActivityLogTool } from './activityTools'
import { getKnowledgeFileTool, searchKnowledgeTool } from './knowledgeTools'
import { outlineTool, readSectionTool, searchDocumentTool } from './sectionTools'
import { deleteSectionTool, editLinesTool, insertMarkdownTool, moveSectionTool, replaceSectionTool, setHeadingTool, swapSectionsTool } from './structuralEditTools'
import { renumberHeadingsTool, replaceAllTool } from './replaceAllTools'
import { loadSkillTool } from './skillTools'
import { delegateRewriteTool, delegateScanTool } from './delegateTools'
import { addReferenceByDoiTool, checkCitationsTool, listReferencesTool } from './citationTools'
import { editProjectContextTool, readProjectContextTool } from './projectContextTools'

// The AI tool registry: every tool the in-app loop, the MCP server and the
// test-only exec route can run, in the order the model is shown them. The
// order is part of the cacheable prompt prefix (`promptAssembly.ts`) and is
// pinned with every description and schema by
// `tests/unit/ai/aiToolListGolden.test.ts`.

/** Always offered (minus what the session's providers can't serve, see `filterToolsForProviders`). */
const CORE_TOOLS = [
  viewDocumentTool,
  replaceTextTool,
  insertTextTool,
  webSearchTool,
  updateThemeTool,
  getThemeTool,
  listThemesTool,
  saveThemeAsPresetTool,
  listWorkspaceDocumentsTool,
  listMyDocumentsTool,
  searchDocumentsTool,
  listFoldersTool,
  createDocumentTool,
  duplicateDocumentTool,
  exportDocumentAsMarkdownTool,
  viewOtherDocumentTool,
  moveDocumentTool,
  createFolderTool,
  setTitleTool,
  viewImageTool,
  generateImageTool,
  getPageCountTool,
  viewPagesTool,
  fetchUrlTool,
  readCommentsTool,
  createCommentTool,
  replyToCommentTool,
  resolveCommentTool,
  deleteCommentTool,
  messageToUserTool,
  searchActivityLogTool,
  outlineTool,
  readSectionTool,
  searchDocumentTool,
  replaceSectionTool,
  insertMarkdownTool,
  moveSectionTool,
  swapSectionsTool,
  deleteSectionTool,
  setHeadingTool,
  renumberHeadingsTool,
  replaceAllTool,
  editLinesTool,
  listReferencesTool,
  addReferenceByDoiTool,
  checkCitationsTool,
  loadSkillTool,
  delegateScanTool,
  delegateRewriteTool
] as const

/**
 * Knowledge-base tools, offered per session by the prompt endpoints: only
 * meaningful when the document is in a workspace the caller belongs to AND
 * that workspace has at least one `status='ready'` knowledge file.
 * Exposing them empty-handed invites the model to hallucinate filenames.
 */
const KNOWLEDGE_TOOLS = [searchKnowledgeTool, getKnowledgeFileTool] as const

/**
 * Project-context tools, offered per session when at least one project
 * context document applies to the document and the initiator may open it
 * (`agentic/sessions/sessionSetup.ts`). Without context they would only
 * invite the model to look for a bible that isn't there.
 */
const CONTEXT_TOOLS = [readProjectContextTool, editProjectContextTool] as const

const ALL_TOOLS = [...CORE_TOOLS, ...KNOWLEDGE_TOOLS, ...CONTEXT_TOOLS] as const

type RegisteredTool = typeof ALL_TOOLS[number]
export type ToolName = RegisteredTool['name']
/** Tools that need no document context (MCP's workspace- and user-bound wrappers accept only these). */
export type MetaToolName = Extract<RegisteredTool, { context: 'meta' }>['name']

const TOOLS_BY_NAME: ReadonlyMap<string, ToolDefinition> = new Map(ALL_TOOLS.map(t => [t.name, t]))

/** Whether `name` is a registered tool (a model can ask for any name). */
export function isToolName(name: string): name is ToolName {
  return TOOLS_BY_NAME.has(name)
}

/** The registered tool called `name`, or undefined. */
export function findTool(name: string): ToolDefinition | undefined {
  return TOOLS_BY_NAME.get(name)
}

/** The runtime validator of `name`'s arguments (the schema its declaration was made from). */
export function toolSchema(name: string): ZodType<unknown> | undefined {
  return findTool(name)?.schema
}

export const ALL_TOOL_DECLARATIONS: FunctionDeclaration[] = CORE_TOOLS.map(toFunctionDeclaration)
export const KNOWLEDGE_TOOL_DECLARATIONS: FunctionDeclaration[] = KNOWLEDGE_TOOLS.map(toFunctionDeclaration)
export const CONTEXT_TOOL_DECLARATIONS: FunctionDeclaration[] = CONTEXT_TOOLS.map(toFunctionDeclaration)

/** Sorted list of every tool name, for the "Supported: ..." error on unknown names. */
const KNOWN_TOOL_NAMES: readonly string[] = Object.freeze(
  ALL_TOOLS.map(t => t.name).sort((a, b) => a.localeCompare(b))
)

/**
 * Tool-call dispatcher. The in-app loop validates the arguments against the
 * tool's schema first (an invalid call never gets here); MCP passes what its
 * own input schema validated, minus the wrapper's `doc_id` / `workspace_id`.
 * The loop's full session is a `DocToolContext`, which every handler accepts
 * (`DocToolContext` extends `MetaToolContext`).
 */
export async function executeFunctionByName(
  session: DocToolContext,
  name: string,
  args: unknown
): Promise<ToolResult> {
  const tool = findTool(name)
  if (!tool) {
    return toolError(`Error: Unsupported function "${name}". Supported: ${KNOWN_TOOL_NAMES.join(', ')}.`)
  }
  return tool.run(session, args)
}

/** Run a document-free tool with a context that has no Y.js document (MCP workspace- / user-bound tools). */
export async function executeMetaTool(ctx: MetaToolContext, name: MetaToolName, args: unknown): Promise<ToolResult> {
  const tool = TOOLS_BY_NAME.get(name) as ToolDefinition<MetaToolName, 'meta'>
  return tool.run(ctx, args)
}

/**
 * Max calls per tool name within a single loop session. Hitting one of
 * these returns a TOOL ERROR (not an abort) so the model sees the cap and
 * can wrap up its response gracefully. Sized against what a pathological
 * loop looks like (each tool says why); `limits.ts` holds the session-wide
 * interaction cap.
 */
export const SESSION_TOOL_CALL_CAPS: Readonly<Record<string, number>> = Object.fromEntries(
  ALL_TOOLS.flatMap(t => ('sessionCallCap' in t && typeof t.sessionCallCap === 'number' ? [[t.name, t.sessionCallCap]] : []))
)

/** Tools that reach beyond the current document, the taint gate asks before running them once tainted. */
export const CONFIRM_WHEN_TAINTED: ReadonlySet<string> = new Set(
  ALL_TOOLS.flatMap(t => ('trustBoundary' in t && t.trustBoundary === 'confirm' ? [t.name] : []))
)

/** URL-taking tools (name → argument holding the URL): free when the invoker typed the URL, otherwise confirm once tainted. */
export const URL_ARG_TOOLS: Readonly<Record<string, string>> = Object.fromEntries(
  ALL_TOOLS.flatMap(t => ('trustBoundary' in t && typeof t.trustBoundary === 'object' ? [[t.name, t.trustBoundary.urlArg]] : []))
)

const ALL_WEB_TOOLS: Readonly<{ search: boolean, fetch: boolean }> = { search: true, fetch: true }

/**
 * Drop tools the session's providers can't serve (BYOK): no image
 * provider → no `generate_image`; a chat model without vision → no
 * `view_image` / `view_pages` (their results are image parts a
 * text-only model would reject). `web_search` / `fetch_url` are dropped
 * when the operator has no Staan / Jina key (`webTools`). Everything else
 * is unaffected.
 */
export function filterToolsForProviders(
  declarations: FunctionDeclaration[],
  providers: { chat: { supportsVision: boolean } | null, image: unknown },
  webTools: Readonly<{ search: boolean, fetch: boolean }> = ALL_WEB_TOOLS
): FunctionDeclaration[] {
  const available: Record<NonNullable<ToolDefinition['requires']>, boolean> = {
    vision: providers.chat?.supportsVision ?? false,
    image: providers.image !== null,
    webSearch: webTools.search,
    webFetch: webTools.fetch
  }
  return declarations.filter((d) => {
    const requires = findTool(d.name ?? '')?.requires
    return requires === undefined || available[requires]
  })
}
