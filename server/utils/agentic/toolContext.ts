import type * as Y from 'yjs'
import type { Awareness } from 'y-protocols/awareness'
import type { AttributedTo } from '../billing/billing'
import type { PlanName } from '~~/shared/config/tiers'
import type { AiStatusInput } from '~~/shared/ai/statusSteps'
import type { ResolvedAiProviders } from '../aiProviders/resolve'
import type { DocAccess, UserScope, WorkspaceAccess } from '../../repos/proofs'
import type { JobConfirmationDetails } from '~~/shared/ai/jobConfirmation'
import type { ReplaceConfirmationDetails } from '~~/shared/ai/replaceConfirmation'
import type { SuggestSink } from '../ai/tools/textWrite'

// Two-tiered tool context. The split exists to make a class of bug
// IMPOSSIBLE: a META-typed handler (one that doesn't need Y.js state)
// being wrapped as a doc-bound MCP tool (and vice versa) won't typecheck
// `buildWorkspaceBoundTool({ name: 'replace_text' })` is a compile
// error because `replace_text` is typed as accepting `DocToolContext`
// but the wrapper passes `MetaToolContext`.
//
// The categorization is an intrinsic property of each handler:
//   - DOC handlers READ or MUTATE the live Y.Doc (ydoc/ytext/ymeta) OR
//     broadcast status via awareness on a real provider.
//   - META handlers operate on DB rows + external APIs only, they need
//     identity (userId, workspaceId, docId) and billing context, but
//     never the Y handles.
//
// Both consumers (in-app loop, MCP wrappers) build the appropriate
// shape: the loop's `AiSession extends DocToolContext`; MCP's
// `connectAsMcpClient` returns `DocToolContext`; MCP's stub-context
// helpers return `MetaToolContext`.

export type ToolStatusPhase = 'thinking' | 'tool' | 'editing' | 'done' | 'error'

/**
 * Identity + billing + status broadcast. Sufficient for handlers that
 * touch DB rows or external APIs but don't need to read or mutate the
 * live Y.Doc. Examples: list_themes, search_knowledge, web_search.
 */
export interface MetaToolContext {
  /** The doc the call is bound to. For tools that don't operate on a
   *  specific doc (web_search, list_my_documents), the wrapper sets
   *  this to a sentinel string, handlers MUST NOT assume it's a real
   *  docId. */
  docId: string

  /** Real human user id, used for ownership checks, audited writes
   *  (e.g. `uploads.uploaderId` from `generate_image`), and rate
   *  limits. The synthetic principal (loop's `ai:assistant:{sessionId}`,
   *  MCP's `mcp:{mcpSessionId}`) lives in `sessionId`; the human is
   *  the truth source for "who's responsible". */
  initiatorUserId: number

  /** Workspace the doc belongs to, if any. `null` for standalone docs
   *  + user-only tool calls. */
  workspaceId: string | null

  /** The initiator acting on their own data (saved themes, their documents, uploads). */
  self: UserScope

  /** The bound document, proven for the initiator at session start (null
   *  for workspace-bound and user-only MCP calls). Write tools narrow it
   *  with `allows('write')`. */
  docAccess: DocAccess<'view'> | null

  /** The initiator's membership of `workspaceId`, proven at session start
   *  (null outside a workspace or without a role). */
  workspaceAccess: WorkspaceAccess<'member'> | null

  /** Suggesting mode: text edits become suggestions (`ai/tools/textWrite.ts`); null / absent = edit directly.
   *  On the meta context too: a meta tool that writes another document's text follows it. */
  suggestSink?: SuggestSink | null

  /** Per-invocation correlation id. The in-app loop uses the AI
   *  session id; MCP uses the MCP session id. Tools tag Y.js
   *  `transact()` with `'<principal>:{sessionId}'` so activity-log
   *  rows can attribute back to the originating call. */
  sessionId: string

  /** Billing target: `user:{id}` self-bill, or `workspace:{id}` when
   *  the workspace's pooled budget covers the cost. */
  attributedTo: AttributedTo

  /** Plan that applies to this call (gates per-tier features +
   *  determines AI Points budget). Snapshotted at consumer boundary. */
  plan: PlanName

  /** Billing-period start. Paid users: Stripe anniversary. Free users:
   *  calendar-month UTC. */
  periodStart: Date

  /** Per-user (or per-workspace-member) LiteLLM virtual-key bearer
   *  token. Tools that hit LiteLLM (web_search, fetch_url,
   *  generate_image, search_knowledge embeddings) pass this to
   *  `useLitellmForUser(virtualKey)` so spend lands on the right
   *  budget. */
  virtualKey: string

  /** AI providers for this call, resolved once at the consumer boundary
   *  (user's BYOK config → instance default → null). LLM sub-calls
   *  (web-tool synthesis → `chat`, `generate_image` → `image`) run on
   *  these; a null capability means the feature is unavailable. */
  aiProviders: ResolvedAiProviders

  /** Report progress. Only the PHASE is broadcast to the document's
   *  other participants (loop: awareness `aiStatus`, MCP doc-bound:
   *  `mcpStatus`); the message (which can name other documents,
   *  queries, URLs) goes to the initiator alone, the loop's session
   *  channel (`sessionChannel.ts`), nowhere for MCP (the MCP client sees
   *  the tool result). META wrappers no-op. */
  updateStatus(phase: ToolStatusPhase, status?: AiStatusInput): void
}

/**
 * Full context: META plus live Y.js handles. Required by handlers
 * that read/mutate the doc body (view_document, replace_text), the
 * doc metadata (set_title, update_theme), the comments array
 * (read_comments, create_comment, ...), or write to awareness directly
 * (message_to_user).
 *
 * `AiSession` (in `aiClient.ts`) extends this with provider lifecycle.
 * MCP's `connectAsMcpClient` returns this shape directly.
 */
export interface DocToolContext extends MetaToolContext {
  docAccess: DocAccess<'view'>
  ydoc: Y.Doc
  ytext: Y.Text
  ymeta: Y.Map<unknown>
  awareness: Awareness
  /** Deliver a `message_to_user` answer to the initiator only (never
   *  via awareness). Absent where there is no initiator UI (MCP, test
   *  seams): the handler then only records conversation memory. */
  deliverResponse?(response: { message: string, isQuestion: boolean, ts: number }): void
  /** Ask the initiator to start a delegated job at this cost (prompt bar,
   *  initiator-only channel). Deny, timeout and errors resolve not allowed.
   *  Absent where nobody can be asked (MCP, test seams): the tool then
   *  refuses a job that needs a confirmation. */
  confirmJob?(details: JobConfirmationDetails): Promise<{ allowed: boolean, note: string | null }>
  /** Ask the initiator to apply a large `replace_all` (count + word forms).
   *  Deny, timeout and errors resolve not allowed. Absent where nobody can
   *  be asked (MCP, test seams): the replacement then applies directly. */
  confirmReplace?(details: ReplaceConfirmationDetails): Promise<{ allowed: boolean, note: string | null }>
  /** When the in-app session is aborted (epoch ms); absent elsewhere. A
   *  tool that waits (a small delegated job) stops well before it. */
  sessionDeadlineAt?: number
  /** The session's abort signal; absent elsewhere. */
  sessionSignal?: AbortSignal
}

/**
 * @deprecated Use `DocToolContext` (handlers that need Y handles) or
 * `MetaToolContext` (handlers that don't) explicitly. New code should pick
 * the narrower of the two.
 */
export type ToolContext = DocToolContext

/**
 * The bound document's proof narrowed to `write`, for tools that change it.
 * In-app sessions are opened with write access and the MCP wrapper binds
 * write tools with `access: 'edit'`, so a view-only proof here is a wiring
 * bug: fail closed.
 */
export function writeAccessOf(ctx: DocToolContext): DocAccess<'write'> {
  const access = ctx.docAccess
  if (!access.allows('write')) throw new Error(`tool on ${ctx.docId} needs write access`)
  return access
}
