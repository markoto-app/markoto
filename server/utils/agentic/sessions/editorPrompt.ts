import type { H3Event } from 'h3'
import { getDoc } from '../../../repos/documents'
import type { DocAccess, UserScope } from '../../../repos/proofs'
import { appendAiMessage, lastActivityAt, loadRecentMessages } from '../../../repos/aiSessionMessages'
import { buildConversationContextForPrompt, shouldRecordToolInMemory, summarizeToolCall } from '../conversationMemory'
import { validateEditorSelection, wrapPromptWithEditorState } from '../editorStatePrompt'
import { buildKnowledgeBlock, buildWorkspaceMembersBlock, withKnowledgeNote } from '../workspacePromptBlocks'
import { assemblePromptContext, PROMPT_SYSTEM_PROMPT } from '../promptAssembly'
import { useLogger } from '../../platform/logger'
import { documentContextBlockFor, openAiSession, resolveSessionWorkspace } from './sessionSetup'
import { runAgentSession } from './runSession'

const log = useLogger('ai-prompt')

// An editor prompt (`POST /api/ai/prompt`, the prompt bar): the
// conversation memory of this user on this document opens the first user
// message, the prompt itself is wrapped with the editor state (selection /
// cursor), and every tool call is remembered for the next prompt.

export interface EditorPromptRequest {
  /** The route's write proof for the document (`allow.doc('write-content')`). */
  docAccess: DocAccess<'write'>
  self: UserScope
  user: { id: number, name: string }
  prompt: string
  editorSelection?: unknown
}

export async function startEditorPrompt(event: H3Event, request: EditorPromptRequest): Promise<{ sessionId: string }> {
  const { docAccess, self } = request
  const docId = docAccess.docId
  const userId = request.user.id
  // A bad editor-state snapshot falls back to `kind: 'none'` instead of
  // failing the request.
  const prompt = request.prompt
  const wrappedPrompt = wrapPromptWithEditorState(prompt, validateEditorSelection(request.editorSelection))

  const doc = await getDoc(docAccess)
  const wsCtx = await resolveSessionWorkspace(doc?.workspaceId ?? null, userId)
  const documentContextBlock = documentContextBlockFor(doc)
  const conversationBlock = await loadConversationBlock(docAccess)
  // Ordered for prompt caching (`agentic/promptAssembly.ts`): the system
  // message is the static prompt alone; the per-document blocks
  // (`promptContext`) and then the per-prompt conversation memory
  // (`promptPreamble`) open the first USER message. Anything per document in
  // the system message would make the cached tool definitions per document
  // on Mistral Small.
  const promptContext = assemblePromptContext({
    documentContextBlock,
    knowledgeBlock: buildKnowledgeBlock(wsCtx.knowledgeFiles),
    membersBlock: buildWorkspaceMembersBlock(wsCtx.members)
  })

  const session = await openAiSession(event, {
    docId,
    docAccess,
    self,
    userId,
    userName: request.user.name,
    workspaceId: wsCtx.workspaceId,
    channelPrompt: prompt,
    commentThreadId: null
  })
  const memory = { docAccess, sessionId: session.sessionId }

  void runAgentSession({
    docId,
    userId,
    docAccess,
    self,
    workspace: wsCtx,
    session,
    systemPrompt: PROMPT_SYSTEM_PROMPT,
    promptContext,
    initialPrompt: withKnowledgeNote(wrappedPrompt, wsCtx.exposeKnowledgeTools),
    promptPreamble: conversationBlock,
    invokerText: prompt,
    toolDeclarations: wsCtx.toolDeclarations,
    workspaceId: wsCtx.workspaceId,
    knowledgeFiles: wsCtx.knowledgeFiles,
    beforeStart: () => recordUserPromptMemory(memory, prompt),
    onToolCall: (name, validatedArgs) => recordToolCallMemory(memory, name, validatedArgs),
    log,
    failure: { component: 'aiPrompt', fields: { sessionId: session.sessionId, docId } }
  })

  return { sessionId: session.sessionId }
}

/**
 * Conversation memory for THIS (doc, user) pair; empty when there are no prior
 * rows or the latest is older than the idle gap (60 min). Read failures
 * degrade to no memory rather than blocking the prompt.
 */
async function loadConversationBlock(docAccess: DocAccess<'write'>): Promise<string> {
  try {
    const lastAt = await lastActivityAt(docAccess)
    const ctx = await buildConversationContextForPrompt(
      since => loadRecentMessages(docAccess, { since }),
      lastAt
    )
    return ctx.block
  } catch (e) {
    log.warn('conversation memory load failed', { err: e })
    return ''
  }
}

interface MemoryKey {
  /** The session's document, proven for its initiator: the memory row's document and user. */
  docAccess: DocAccess<'write'>
  sessionId: string
}

/**
 * Records the user's verbatim prompt FIRST, before the AI Hocuspocus client
 * opens, so memory captures the intent even if sync / model spin-up fails.
 * Stores the bare prompt, not the editor-state-wrapped one. Failures are
 * swallowed; memory is never load-bearing.
 */
async function recordUserPromptMemory(key: MemoryKey, prompt: string): Promise<void> {
  try {
    await appendAiMessage(key.docAccess, {
      sessionId: key.sessionId,
      kind: 'user_prompt',
      body: { text: prompt }
    })
  } catch (e) {
    log.warn('user_prompt memory append failed', { err: e })
  }
}

/**
 * Per-call memory recorder: {name, summary} only, without the result payload,
 * so the model re-issues a call when it needs the data again. Skips noise
 * tools (view_document, read_comments, ...) the model re-runs every turn.
 */
async function recordToolCallMemory(key: MemoryKey, name: string, validatedArgs: unknown): Promise<void> {
  if (!shouldRecordToolInMemory(name)) return
  try {
    await appendAiMessage(key.docAccess, {
      sessionId: key.sessionId,
      kind: 'tool_call',
      body: { name, summary: summarizeToolCall(name, validatedArgs) }
    })
  } catch (e) {
    log.warn('tool_call memory append failed', { tool: name, err: e })
  }
}
