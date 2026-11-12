import type { ZodRawShape } from 'zod'
import type { H3Event } from 'h3'
import type { ShapeOutput } from '@modelcontextprotocol/sdk/server/zod-compat.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { defineMcpTool, type McpRequestExtra, type McpToolCallback } from '@nuxtjs/mcp-toolkit/server'
import { stripWrapperArgs } from './stripWrapperArgs'
import { DOWNLOAD_DISABLED_MESSAGE, userMayDownload } from '../../utils/access/shareSettings'
import { proveWorkspaceAccess } from '../../utils/access/workspaceAccess'
import { proveDocMembership } from '../../utils/access/docProof'
import { proveSelf } from '../../utils/access/userProof'
import type { DocAccess, WorkspaceAccess } from '../../repos/proofs'
import { findUserName } from '../../repos/users'
import { connectAsMcpClient } from '../../utils/mcp/mcpHocuspocusClient'
import { executeFunctionByName, executeMetaTool, type MetaToolName, type ToolName } from '../../utils/ai/tools/registry'
import { requireMcpAuth, hasScope, toolEnabled } from './mcpToolContext'
import { resolveBillingContext } from '../../utils/billing/billing'
import { resolveAiProviders } from '../../utils/aiProviders/resolve'
import type { ToolResult } from '../../utils/ai/tools/toolDefinition'
import type { MetaToolContext, ToolStatusPhase } from '../../utils/agentic/toolContext'
import type { McpAuthContext, McpScope } from '../../utils/mcp/mcpAuth'
import { checkRateLimit } from '../../utils/platform/rateLimit'
import { consumeRenderAllowance } from '../../utils/rendering/renderRateLimit'
import { MCP_RATE_LIMITS, type RateLimitRule } from './mcpGate'
import { mcpToolAllowed } from './toolClasses'
import { PLAN_FEATURE_UNAVAILABLE_CODE, PLAN_LIMIT_REACHED_CODE } from '~~/shared/config/planErrors'
import { limitRecovery } from '../../utils/billing/billingMode'
import { apiError } from '../../utils/api/apiError'

// Wrappers that bake the per-class boilerplate every MCP tool needs.
// Three flavors based on what context the tool needs to operate on:
//
//   buildDocBoundTool       — tool reads/mutates a specific doc.
//                              Takes `doc_id` arg; opens YDocPool entry.
//   buildWorkspaceBoundTool — tool operates on a workspace (knowledge,
//                              workspace docs). Takes `workspace_id` arg;
//                              membership-checked; no Y handles.
//   buildUserOnlyTool       — tool operates on the user's own data
//                              (saved themes, my docs, web/url tools).
//                              No doc / workspace context.
//
// Each wrapper:
//   - Includes a scope guard (`enabled` returns false unless the PAT
//     carries the right scope).
//   - Authz-checks against the PAT-resolved userId.
//   - Builds a ToolContext appropriate for the class (real Y handles
//     for doc-bound, in-memory stub Y.Doc for workspace + user-only).
//   - Dispatches through the tool registry (`utils/ai/tools/registry.ts`).
//   - Releases pool entries / cleans up stub Y handles in `finally`.
//
// Audit chain (verified end-to-end by tests/integration/mcp/audit-and-session.test.ts):
//   activity_log.actor_principal LIKE 'mcp:%'
//     → strip 'mcp:' → mcp_sessions.mcp_session_id
//     → mcp_sessions.user_id + client_name + token_id
// Forensic queries for "what did Claude Desktop do at 14:32" join
// activity_log → mcp_sessions → users via the actor_principal column.

/**
 * Extra per-call allowance for expensive tools: `'render'` = the shared
 * server-render allowance (same bucket as `GET /api/docs/:id/pdf`), or a
 * per-user rule (e.g. `MCP_RATE_LIMITS.generateImagePerUser`).
 */
export type ToolCallLimit = 'render' | RateLimitRule

/**
 * Admission check every MCP tool handler runs first:
 *   - authenticated (the middleware already refused anonymous requests),
 *   - the token CURRENTLY grants the tool's scope — the toolkit fixed the
 *     session's tool list at `initialize`, so this re-check is what makes
 *     scopes binding per call,
 *   - per-user tool-call rate limit, plus the tool's extra limit.
 * A missing scope answers like an unknown tool (no existence oracle).
 */
export async function admitToolCall(event: H3Event, name: string, scope: McpScope, limit?: ToolCallLimit): Promise<McpAuthContext> {
  const auth = requireMcpAuth(event)
  if (!hasScope(event, scope)) {
    throw apiError('mcp/tool-not-found', { tool: name })
  }
  // Plan: without `mcpWrite` only read tools run (lib/toolClasses.ts).
  const plan = event.context.mcpPlan
  if (plan && !mcpToolAllowed(name, plan.mcpWrite)) {
    throw createError({
      statusCode: 409,
      message: `${name} changes content or costs platform resources, which your plan doesn't include over MCP. Read-only tools still work.`,
      data: { code: PLAN_FEATURE_UNAVAILABLE_CODE, feature: 'mcpWrite', messageKey: 'plan.feature.mcpWrite', recovery: limitRecovery() }
    })
  }
  const perUser = MCP_RATE_LIMITS.toolCallsPerUser
  if (!(await checkRateLimit(perUser.namespace, String(auth.userId), perUser.max, perUser.windowMs))) {
    throw toolCallLimitError(perUser)
  }
  // Plan: daily tool-call allowance (`mcpToolCallsPerDay`, null = none).
  const daily = plan?.mcpToolCallsPerDay ?? null
  if (daily !== null) {
    const rule = MCP_RATE_LIMITS.toolCallsPerUserDaily
    if (!(await checkRateLimit(rule.namespace, String(auth.userId), daily, rule.windowMs))) {
      throw createError({
        statusCode: 429,
        message: `Your plan includes ${daily} MCP tool calls per day. Try again tomorrow.`,
        data: { code: PLAN_LIMIT_REACHED_CODE, field: 'mcpToolCallsPerDay', limit: daily, messageKey: 'plan.limit.mcpToolCallsPerDay', recovery: limitRecovery() }
      })
    }
  }
  if (limit === 'render') {
    if (!(await consumeRenderAllowance(event))) {
      throw apiError('mcp/render-rate-limited')
    }
  } else if (limit && !(await checkRateLimit(limit.namespace, String(auth.userId), limit.max, limit.windowMs))) {
    throw toolCallLimitError(limit, name)
  }
  return auth
}

function toolCallLimitError(rule: RateLimitRule, tool?: string) {
  return apiError('mcp/tool-call-limit', { limit: rule.max, minutes: Math.round(rule.windowMs / 60_000), ...(tool ? { tool } : {}) })
}

export type ToolAnnotations = {
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

export interface WrapDocBoundToolOpts<Schema extends ZodRawShape> {
  /** Any ToolName (DOC or META). The type split's load-bearing
   *  invariant runs in the OTHER direction (META wrappers can't accept
   *  DOC names, see WrapWorkspaceBoundToolOpts / WrapUserOnlyToolOpts).
   *  A META handler wrapped here gets a YDocPool checkout it doesn't
   *  use — wasteful but not incorrect; we accept it for the case of
   *  doc-scoped queries like `search_activity_log` (META) that
   *  conceptually take a doc_id but never read the live Y.Doc. */
  name: ToolName
  description: string
  inputSchema: Schema
  scope: McpScope
  /** 'view' = canView required; 'edit' = canEdit required. */
  access: 'view' | 'edit'
  annotations?: ToolAnnotations
  /** Extra per-call allowance (render tools, image generation). */
  limit?: ToolCallLimit
  /** The result carries the document out (page images): refused to
   *  visitors of a view-only document (share controls). */
  download?: boolean
}

export function buildDocBoundTool<Schema extends ZodRawShape>(opts: WrapDocBoundToolOpts<Schema>) {
  assertSchemaContains(opts.inputSchema, 'doc_id', opts.name)

  // `defineMcpTool` is called inside the helper so the generic Schema
  // flows through to its `McpToolDefinition<Schema>` return type. Build-
  // ing the object externally and passing it in loses the inference
  // because TypeScript can't reconnect the schema generic to the
  // handler signature across the function boundary.
  return defineMcpTool({
    name: opts.name,
    title: titleFromName(opts.name),
    description: opts.description,
    inputSchema: opts.inputSchema,
    annotations: opts.annotations ?? {},
    enabled: (event: H3Event): boolean => toolEnabled(event, opts.scope, opts.name),
    handler: (async (args: ShapeOutput<Schema>, _extra: McpRequestExtra): Promise<CallToolResult> => {
      const event = useEvent()
      const auth = await admitToolCall(event, opts.name, opts.scope, opts.limit)
      const docId = String(args.doc_id ?? '')
      if (!docId) {
        throw apiError('mcp/missing-doc-id')
      }

      // `assertDocAccess` returns the resolved authz info so we can
      // thread `workspaceId` into `connectAsMcpClient` instead of
      // having that helper re-query `getDoc`. One DB round-trip per
      // tool call, not two.
      const authz = await assertDocAccess(auth.userId, docId, opts.access)
      if (opts.download && !(await userMayDownload(docId, auth.userId))) {
        return { content: [{ type: 'text', text: DOWNLOAD_DISABLED_MESSAGE }], isError: true }
      }

      const self = proveSelf(auth.userId)
      const userName = (await findUserName(self)) ?? `user-${auth.userId}`
      const mcpSessionId = mcpSessionIdFromEvent(event) ?? `oneshot-${Date.now()}`

      const handle = await connectAsMcpClient({
        docId,
        userId: auth.userId,
        mcpSessionId,
        userName,
        workspaceId: authz.workspaceId,
        docAccess: authz.access,
        self,
        workspaceAccess: authz.workspaceId ? await proveWorkspaceAccess(auth.userId, authz.workspaceId, 'member') : null
      })
      try {
        // The registry runs DOC and META tools alike with handle.ctx
        // (DocToolContext) — META handlers via structural subtyping
        // (DocToolContext extends MetaToolContext).
        // We strip wrapper-injected `doc_id` from the args before
        // dispatch so the handler receives the SAME shape the in-app
        // loop passes (the loop carries docId out-of-band on
        // DocToolContext). Without this strip, handlers that do
        // `{...patch}`-style spread (e.g. `coerceThemePatch` in
        // update_theme) leak `doc_id` into downstream merges and
        // strict-validators reject the result. See `stripWrapperArgs`
        // for the full rationale.
        const handlerArgs = stripWrapperArgs(args, 'doc_id')
        return toolResultToCallToolResult(await executeFunctionByName(handle.ctx, opts.name, handlerArgs))
      } finally {
        handle.release()
      }
    }) as McpToolCallback<Schema>
  })
}

export interface WrapWorkspaceBoundToolOpts<Schema extends ZodRawShape> {
  /** Must be a document-free (`meta`) tool. Compile error if you try to
   *  pass a doc-bound name (e.g. 'replace_text') — that's the whole
   *  point of the type-narrowing. */
  name: MetaToolName
  description: string
  inputSchema: Schema
  scope: McpScope
  /** Minimum workspace role required. Knowledge tools are 'viewer';
   *  destructive workspace tools (none yet) would be 'admin'. */
  minRole: 'viewer' | 'editor' | 'admin'
  annotations?: ToolAnnotations
}

export function buildWorkspaceBoundTool<Schema extends ZodRawShape>(opts: WrapWorkspaceBoundToolOpts<Schema>) {
  assertSchemaContains(opts.inputSchema, 'workspace_id', opts.name)

  return defineMcpTool({
    name: opts.name,
    title: titleFromName(opts.name),
    description: opts.description,
    inputSchema: opts.inputSchema,
    annotations: opts.annotations ?? {},
    enabled: (event: H3Event): boolean => toolEnabled(event, opts.scope, opts.name),
    handler: (async (args: ShapeOutput<Schema>, _extra: McpRequestExtra): Promise<CallToolResult> => {
      const event = useEvent()
      const auth = await admitToolCall(event, opts.name, opts.scope)
      const workspaceId = String(args.workspace_id ?? '')
      if (!workspaceId) {
        throw apiError('mcp/missing-workspace-id')
      }

      const workspaceAccess = await proveWorkspaceAccess(auth.userId, workspaceId, 'member')
      if (!workspaceAccess || !workspaceAccess.allows(MIN_ROLE_LEVEL[opts.minRole])) {
        // Same anti-enumeration shape as a document refusal.
        throw apiError('mcp/workspace-not-found')
      }

      const ctx = await buildStubContext(auth.userId, workspaceAccess, mcpSessionIdFromEvent(event))
      try {
        // Strip the wrapper-injected `workspace_id` for the same
        // reason `buildDocBoundTool` strips `doc_id` — keeps the
        // handler's args shape identical to what the in-app loop
        // passes (loop carries workspaceId on MetaToolContext).
        const handlerArgs = stripWrapperArgs(args, 'workspace_id')
        return toolResultToCallToolResult(await executeMetaTool(ctx.ctx, opts.name, handlerArgs))
      } finally {
        ctx.dispose()
      }
    }) as McpToolCallback<Schema>
  })
}

export interface WrapUserOnlyToolOpts<Schema extends ZodRawShape> {
  /** Must be a document-free (`meta`) tool. */
  name: MetaToolName
  description: string
  inputSchema: Schema
  scope: McpScope
  annotations?: ToolAnnotations
  /**
   * Optional availability gate (e.g. the operator has no Staan / Jina key
   * for the web tools). When it returns false the tool is not listed for
   * the client at all. Per-user rate limiting of the web tools lives in the
   * shared handler (`consumeWebToolQuota`), so the in-app loop and MCP
   * draw on one allowance.
   */
  available?: () => boolean
}

export function buildUserOnlyTool<Schema extends ZodRawShape>(opts: WrapUserOnlyToolOpts<Schema>) {
  return defineMcpTool({
    name: opts.name,
    title: titleFromName(opts.name),
    description: opts.description,
    inputSchema: opts.inputSchema,
    annotations: opts.annotations ?? {},
    enabled: (event: H3Event): boolean => toolEnabled(event, opts.scope, opts.name) && (opts.available?.() ?? true),
    handler: (async (args: ShapeOutput<Schema>, _extra: McpRequestExtra): Promise<CallToolResult> => {
      const event = useEvent()
      const auth = await admitToolCall(event, opts.name, opts.scope)
      const ctx = await buildStubContext(auth.userId, null, mcpSessionIdFromEvent(event))
      try {
        return toolResultToCallToolResult(await executeMetaTool(ctx.ctx, opts.name, args))
      } finally {
        ctx.dispose()
      }
    }) as McpToolCallback<Schema>
  })
}

/**
 * Translate the in-app loop's `ToolResult` shape into MCP's
 * `CallToolResult`. The loop uses `{ content: string, isError, extraParts }`;
 * MCP uses `{ content: ContentBlock[], isError, structuredContent? }`.
 *
 * `extraParts` (image inlineData) get converted to MCP image content
 * blocks. JSON returns from the loop's text content stay as text.
 */
function toolResultToCallToolResult(r: ToolResult): CallToolResult {
  const text = { type: 'text' as const, text: r.content }
  if (!r.extraParts || r.extraParts.length === 0) {
    return { content: [text], isError: r.isError }
  }
  const extras = r.extraParts.flatMap((part): CallToolResult['content'] => {
    if ('inlineData' in part && part.inlineData?.data && part.inlineData.mimeType) {
      return [{
        type: 'image' as const,
        data: part.inlineData.data,
        mimeType: part.inlineData.mimeType
      }]
    }
    return []
  })
  return { content: [text, ...extras], isError: r.isError }
}

function titleFromName(name: string): string {
  return name.split('_').map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(' ')
}

function mcpSessionIdFromEvent(event: H3Event): string | null {
  const v = getHeader(event, 'mcp-session-id')
  return typeof v === 'string' && v.length > 0 ? v : null
}

function assertSchemaContains(schema: ZodRawShape, field: string, name: string): void {
  if (!(field in schema)) {
    throw new Error(`[mcp] Tool "${name}" missing required \`${field}\` field in inputSchema.`)
  }
}

const MIN_ROLE_LEVEL = { viewer: 'member', editor: 'editor', admin: 'admin' } as const

/**
 * Authz check: the token owner's membership grant on the document (`view`:
 * owner or any workspace role; `edit`: owner, workspace admin or editor),
 * as a proof the tool context carries, plus the workspace for the client.
 */
async function assertDocAccess(
  userId: number,
  docId: string,
  kind: 'view' | 'edit'
): Promise<{ workspaceId: string | null, access: DocAccess<'view'> }> {
  const proven = await proveDocMembership(userId, docId, kind)
  if (!proven) {
    // 404-shape (not 403) for missing and refused alike — matches the
    // in-app endpoints' anti-enumeration policy.
    throw apiError('mcp/doc-not-found')
  }
  return { workspaceId: proven.workspaceId, access: proven.access }
}

/**
 * Build a `MetaToolContext` for handlers that don't touch Y.js state
 * (workspace-bound queries, user-only data fetches). MetaToolContext
 * doesn't include `ydoc`/`ytext`/`ymeta`/`awareness` — the type system
 * makes it impossible to misroute a doc-bound handler through here.
 *
 * Idiomatically there's no Y.Doc to dispose; the `dispose` field is
 * kept on the return shape so the call site stays symmetric with
 * `connectAsMcpClient`'s `release()`.
 */
async function buildStubContext(
  userId: number,
  workspaceAccess: WorkspaceAccess<'member'> | null,
  mcpSessionId: string | null
): Promise<{ ctx: MetaToolContext, dispose: () => void }> {
  const workspaceId = workspaceAccess?.workspaceId ?? null
  const self = proveSelf(userId)
  const billingContext = await resolveBillingContext(userId, workspaceId)
  const aiProviders = await resolveAiProviders(self, billingContext.plan)
  const sessionId = mcpSessionId ?? `oneshot-${Date.now()}`

  const ctx: MetaToolContext = {
    // Sentinel — handlers that need a real doc don't take MetaToolContext
    // (caught at compile time by the dispatch table split). Logging
    // sites that do happen to read `ctx.docId` see this string and can
    // distinguish "no doc context" from a real id.
    docId: 'mcp:no-doc-context',
    initiatorUserId: userId,
    workspaceId,
    self,
    docAccess: null,
    workspaceAccess,
    sessionId,
    attributedTo: billingContext.attributedTo,
    plan: billingContext.plan,
    periodStart: billingContext.periodStart,
    virtualKey: billingContext.virtualKey,
    aiProviders,
    updateStatus: (_phase: ToolStatusPhase, _message?: string) => {
      // No-op — workspace/user-only tools have no doc-level awareness
      // to broadcast on. The MCP client gets the result via the normal
      // tool-call return; live doc collaborators can't see this work
      // happen (which is correct — it's not on a doc).
    }
  }
  return {
    ctx,
    dispose: () => {
      // No-op — no Y.Doc to tear down. Kept for call-site symmetry
      // with `connectAsMcpClient`'s `release()`.
    }
  }
}
