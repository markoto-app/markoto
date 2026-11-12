import type { H3Event } from 'h3'
import { getDoc } from '../../../repos/documents'
import { appendAiMessage, lastActivityAt, loadRecentMessages } from '../../../repos/aiSessionMessages'
import { buildConversationContextForPrompt, shouldRecordToolInMemory, summarizeToolCall } from '../conversationMemory'
import { validateEditorSelection, wrapPromptWithEditorState } from '../editorStatePrompt'
import { buildKnowledgeBlock, buildWorkspaceMembersBlock } from '../workspacePromptBlocks'
import { assemblePromptSystemPrompt, PROMPT_SYSTEM_PROMPT } from '../promptAssembly'
import { useLogger } from '../../platform/logger'
import { documentContextBlockFor, openAiSession, resolveSessionWorkspace } from './sessionSetup'
import { runAgentSession } from './runSession'

const log = useLogger('ai-prompt')

// An editor prompt (`POST /api/ai/prompt`, the prompt bar): the
// conversation memory of this user on this document opens the first user
// message, the prompt itself is wrapped with the editor state (selection /
// cursor), and every tool call is remembered for the next prompt.

export interface EditorPromptRequest {
  docId: string
  user: { id: number, name: string }
  prompt: string
  editorSelection?: unknown
}

export async function startEditorPrompt(event: H3Event, request: EditorPromptRequest): Promise<{ sessionId: string }> {
  const { docId } = request
  const userId = request.user.id
  // A bad editor-state snapshot falls back to `kind: 'none'` instead of
  // failing the request.
  const prompt = request.prompt
  const wrappedPrompt = wrapPromptWithEditorState(prompt, validateEditorSelection(request.editorSelection))

  const doc = await getDoc(docId)
  const wsCtx = await resolveSessionWorkspace(doc?.workspaceId ?? null, userId)
  const documentContextBlock = documentContextBlockFor(doc)
  const conversationBlock = await loadConversationBlock(docId, userId)
  // Ordered for prompt caching (`agentic/promptAssembly.ts`): the system
  // message is static-first, and the per-prompt conversation memory opens the
  // first USER message (`promptPreamble`) instead. Placing it in the system
  // message invalidated the cached tool definitions on Mistral Small.
  const systemPrompt = assemblePromptSystemPrompt(PROMPT_SYSTEM_PROMPT, {
    documentContextBlock,
    knowledgeBlock: buildKnowledgeBlock(wsCtx.knowledgeFiles),
    membersBlock: buildWorkspaceMembersBlock(wsCtx.members)
  })

  const session = await openAiSession(event, {
    docId,
    userId,
    userName: request.user.name,
    workspaceId: wsCtx.workspaceId,
    channelPrompt: prompt,
    commentThreadId: null
  })
  const memory = { docId, userId, sessionId: session.sessionId }

  void runAgentSession({
    docId,
    userId,
    session,
    systemPrompt,
    initialPrompt: wrappedPrompt,
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
async function loadConversationBlock(docId: string, userId: number): Promise<string> {
  try {
    const lastAt = await lastActivityAt(docId, userId)
    const ctx = await buildConversationContextForPrompt(
      since => loadRecentMessages(docId, userId, { since }),
      lastAt
    )
    return ctx.block
  } catch (e) {
    log.warn('conversation memory load failed', { err: e })
    return ''
  }
}

interface MemoryKey {
  docId: string
  userId: number
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
    await appendAiMessage({
      docId: key.docId,
      userId: key.userId,
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
    await appendAiMessage({
      docId: key.docId,
      userId: key.userId,
      sessionId: key.sessionId,
      kind: 'tool_call',
      body: { name, summary: summarizeToolCall(name, validatedArgs) }
    })
  } catch (e) {
    log.warn('tool_call memory append failed', { tool: name, err: e })
  }
}
