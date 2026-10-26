import type * as Y from 'yjs'
import type { Awareness } from 'y-protocols/awareness'
import type { AttributedTo } from '../billing'
import type { PlanName } from '~~/shared/config/tiers'
import type { ResolvedAiProviders } from '../aiProviders/resolve'

// Two-tiered tool context. The split exists to make a class of bug
// IMPOSSIBLE: a META-typed handler (one that doesn't need Y.js state)
// being wrapped as a doc-bound MCP tool (and vice versa) won't typecheck
// — `buildWorkspaceBoundTool({ name: 'replace_text' })` is a compile
// error because `replace_text` is typed as accepting `DocToolContext`
// but the wrapper passes `MetaToolContext`.
//
// The categorization is an intrinsic property of each handler:
//   - DOC handlers READ or MUTATE the live Y.Doc (ydoc/ytext/ymeta) OR
//     broadcast status via awareness on a real provider.
//   - META handlers operate on DB rows + external APIs only — they need
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
   *  this to a sentinel string — handlers MUST NOT assume it's a real
   *  docId. */
  docId: string

  /** Real human user id — used for ownership checks, audited writes
   *  (e.g. `uploads.uploaderId` from `generate_image`), and rate
   *  limits. The synthetic principal (loop's `ai:assistant:{sessionId}`,
   *  MCP's `mcp:{mcpSessionId}`) lives in `sessionId`; the human is
   *  the truth source for "who's responsible". */
  initiatorUserId: number

  /** Workspace the doc belongs to, if any. `null` for standalone docs
   *  + user-only tool calls. */
  workspaceId: string | null

  /** Per-invocation correlation id. The in-app loop uses the AI
   *  session id; MCP uses the MCP session id. Tools tag Y.js
   *  `transact()` with `'<principal>:{sessionId}'` so activity-log
   *  rows can attribute back to the originating call. */
  sessionId: string

  /** Billing target — `user:{id}` self-bill, or `workspace:{id}` when
   *  a `(+)` workspace's owner covers the cost. */
  attributedTo: AttributedTo

  /** Plan that applies to this call (gates per-tier features +
   *  determines AI Points budget). Snapshotted at consumer boundary. */
  plan: PlanName

  /** Billing-period start. Paid users: Stripe anniversary. Free users:
   *  calendar-month UTC. */
  periodStart: Date

  /** Per-user (or per-(+)-workspace-owner) LiteLLM virtual-key bearer
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

  /** Broadcast a status update. The loop maps this to
   *  `awareness.setLocalStateField('aiStatus', ...)`; MCP doc-bound
   *  wrappers map to `'mcpStatus'`; META wrappers no-op (no
   *  meaningful awareness slot when there's no doc). */
  updateStatus(phase: ToolStatusPhase, message?: string): void
}

/**
 * Full context — META plus live Y.js handles. Required by handlers
 * that read/mutate the doc body (view_document, replace_text), the
 * doc metadata (set_title, update_theme), the comments array
 * (read_comments, create_comment, ...), or write to awareness directly
 * (message_to_user).
 *
 * `AiSession` (in `aiClient.ts`) extends this with provider lifecycle.
 * MCP's `connectAsMcpClient` returns this shape directly.
 */
export interface DocToolContext extends MetaToolContext {
  ydoc: Y.Doc
  ytext: Y.Text
  ymeta: Y.Map<unknown>
  awareness: Awareness
}

/**
 * @deprecated Use `DocToolContext` (handlers that need Y handles) or
 * `MetaToolContext` (handlers that don't) explicitly. The unsplit
 * `ToolContext` alias remains so the migration to per-handler typing
 * doesn't have to land in one big patch. New code SHOULD pick the
 * narrower of the two.
 */
export type ToolContext = DocToolContext
