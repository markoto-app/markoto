import type { H3Event } from 'h3'
import { nanoid } from 'nanoid'
import { findUserName } from '../../../repos/users'
import type { getDoc } from '../../../repos/documents'
import { listMembers } from '../../../repos/workspaceMembers'
import { proveWorkspaceAccess } from '../../access/workspaceAccess'
import type { DocAccess, UserScope, WorkspaceAccess } from '../../../repos/proofs'
import { listReadyKnowledgeBrief } from '../../../repos/knowledge'
import { addAiSession, DuplicateSessionError } from '../../ai/aiSessions'
import { resolveBillingContext, type BillingContext } from '../../billing/billing'
import { requireAiProviders } from '../../aiProviders/guard'
import { assertFreeAllowanceAvailable } from '../../billing/freeAllowance'
import type { ResolvedAiProviders } from '../../aiProviders/resolve'
import { ALL_TOOL_DECLARATIONS, CONTEXT_TOOL_DECLARATIONS, KNOWLEDGE_TOOL_DECLARATIONS } from '../../ai/tools/registry'
import { buildDocumentContext } from '../documentContextPrompt'
import { buildProjectContextBlock } from '../projectContextPrompt'
import { resolveProjectContext } from '../../documents/projectContext'
import { useLogger } from '../../platform/logger'
import { AiSessionChannel } from '../sessionChannel'
import { AI_SESSION_HARD_DEADLINE_MS } from '../limits'
import { recordSessionProvenance } from '../sessionProvenance'
import { apiError } from '../../api/apiError'

// What the editor prompt and the `@ai` comment trigger share before their
// loop runs: the workspace context (members, knowledge, tools), billing +
// provider gates, and claiming the session (one per user per document,
// provenance row, deadline, the initiator-only channel).

export interface SessionWorkspace {
  workspaceId: string | null
  /** The initiator's membership, proven when the session opens. */
  workspaceAccess: WorkspaceAccess<'member'> | null
  knowledgeFiles: Awaited<ReturnType<typeof listReadyKnowledgeBrief>>
  members: Array<{ userId: number, name: string }>
  toolDeclarations: typeof ALL_TOOL_DECLARATIONS
  /** The workspace has ready knowledge files → the knowledge tools are offered. */
  exposeKnowledgeTools: boolean
  /** `<project_context>` for the first user message ('' when none applies). */
  projectContextBlock: string
  /** Context documents in that block (the taint gate checks who wrote them). */
  contextDocIds: string[]
}

const log = useLogger('ai-session-setup')

/**
 * The project context of the session's document as the initiator may read
 * it (`documents/projectContext.ts`), and the context tools when there is
 * any. A failure leaves the session without context instead of failing it.
 */
async function resolveSessionProjectContext(docAccess: DocAccess<'view'>, userId: number): Promise<{ block: string, contextDocIds: string[] }> {
  try {
    const { entries, omitted } = await resolveProjectContext(docAccess, userId)
    return {
      block: buildProjectContextBlock(entries, omitted),
      contextDocIds: entries.map(e => e.docId)
    }
  } catch (e) {
    log.warn('project context unavailable', { err: e })
    return { block: '', contextDocIds: [] }
  }
}

/**
 * Knowledge tools need a workspace doc, a member caller and at least one
 * ready knowledge file. The member-role check also guards against a
 * caller demoted out of the workspace.
 */
export async function resolveSessionWorkspace(rawWorkspaceId: string | null, userId: number, docAccess: DocAccess<'view'>): Promise<SessionWorkspace> {
  const context = await resolveSessionProjectContext(docAccess, userId)
  const contextTools = context.contextDocIds.length > 0 ? CONTEXT_TOOL_DECLARATIONS : []
  const none: SessionWorkspace = {
    workspaceId: null,
    workspaceAccess: null,
    knowledgeFiles: [],
    members: [],
    toolDeclarations: [...ALL_TOOL_DECLARATIONS, ...contextTools],
    exposeKnowledgeTools: false,
    projectContextBlock: context.block,
    contextDocIds: context.contextDocIds
  }
  if (!rawWorkspaceId) return none
  const workspaceAccess = await proveWorkspaceAccess(userId, rawWorkspaceId, 'member')
  if (workspaceAccess === null) return none
  const [members, knowledgeFiles] = await Promise.all([
    listMembers(workspaceAccess),
    listReadyKnowledgeBrief(workspaceAccess)
  ])
  const exposeKnowledgeTools = knowledgeFiles.length > 0
  return {
    ...none,
    workspaceId: rawWorkspaceId,
    workspaceAccess,
    knowledgeFiles,
    members: members.filter(m => m.role !== 'guest').map(m => ({ userId: m.userId, name: m.name })),
    toolDeclarations: [...ALL_TOOL_DECLARATIONS, ...(exposeKnowledgeTools ? KNOWLEDGE_TOOL_DECLARATIONS : []), ...contextTools],
    exposeKnowledgeTools
  }
}

/** The `<document_context>` block (title, description, audience, language); empty without a document row. */
export function documentContextBlockFor(doc: Awaited<ReturnType<typeof getDoc>>): string {
  return doc
    ? buildDocumentContext({
        title: doc.title,
        description: doc.description,
        audience: doc.audience,
        language: doc.language
      })
    : ''
}

/** A claimed session, ready for its background loop. */
export interface OpenedSession {
  sessionId: string
  initiatorName: string
  initiatorColor: string
  abortController: AbortController
  deadlineTimer: ReturnType<typeof setTimeout>
  /** When `deadlineTimer` aborts the session (epoch ms); the loop wraps up shortly before. */
  deadlineAt: number
  channel: AiSessionChannel
  billingContext: BillingContext
  aiProviders: ResolvedAiProviders
}

export interface OpenSessionRequest {
  docId: string
  /** The route's write proof for the document; the session registers on it. */
  docAccess: DocAccess<'write'>
  /** The initiator: whose providers, name and session row. */
  self: UserScope
  userId: number
  userName: string
  workspaceId: string | null
  /** What the initiator's channel shows as the session's prompt. */
  channelPrompt: string
  commentThreadId: string | null
}

export async function openAiSession(event: H3Event, request: OpenSessionRequest): Promise<OpenedSession> {
  const { docId, userId } = request
  // Resolve billing context up-front to lazily create the LiteLLM virtual key
  // and pick the attribution. No exhaustion pre-check: the proxy enforces
  // `max_budget` on the first model call and runLoop catches
  // `LitellmBudgetExhausted` / `isBudgetExceededError(...)`.
  const billingContext = await resolveBillingContext(userId, request.workspaceId)
  // BYOK: the user's own provider (or the instance default). No chat
  // provider → 409 `ai/provider-missing` with a link to the settings page.
  const aiProviders = await requireAiProviders(request.self, 'chat', billingContext.plan)
  // Hosted free tier: the shared monthly pool may be used up, answer
  // 402 `ai/free-allowance-exhausted` before opening a session (own-key
  // users are never refused here).
  await assertFreeAllowanceAvailable(aiProviders.chat, billingContext.plan)

  const initiatorName = (await findUserName(request.self)) || request.userName
  const initiatorColor = '#d97706'

  const sessionId = nanoid(12)
  const abortController = new AbortController()
  const req = event.node?.req
  req?.once?.('close', () => {
    if (!req.readableEnded) abortController.abort()
  })

  await claimAiSession({ sessionId, docAccess: request.docAccess, self: request.self, userId, initiatorName, initiatorColor, abortController })
  const deadlineAt = Date.now() + AI_SESSION_HARD_DEADLINE_MS
  const deadlineTimer = setTimeout(() => abortController.abort(), AI_SESSION_HARD_DEADLINE_MS)
  // Initiator-only channel: prompt, status text, answers, confirmations.
  // Opened before the response so the client's first poll finds it.
  const channel = new AiSessionChannel(sessionId)
  await channel.open({ initiatorUserId: userId, docId, prompt: request.channelPrompt, commentThreadId: request.commentThreadId })
  return { sessionId, initiatorName, initiatorColor, abortController, deadlineTimer, deadlineAt, channel, billingContext, aiProviders }
}

interface ClaimSessionArgs {
  sessionId: string
  docAccess: DocAccess<'write'>
  self: UserScope
  userId: number
  initiatorName: string
  initiatorColor: string
  abortController: AbortController
}

async function claimAiSession(args: ClaimSessionArgs): Promise<void> {
  try {
    await addAiSession(args.docAccess, {
      sessionId: args.sessionId,
      initiatorUserId: args.userId,
      initiatorName: args.initiatorName,
      initiatorColor: args.initiatorColor,
      abortController: args.abortController,
      startedAt: new Date()
    })
  } catch (e) {
    if (e instanceof DuplicateSessionError) {
      throw apiError('ai/duplicate-session')
    }
    throw e
  }
  // Provenance row BEFORE the AI client can write (taint gate, see
  // `sessionProvenance.ts`). Releases the session again on failure.
  await recordSessionProvenance(args.docAccess, args.self, args.sessionId)
}
