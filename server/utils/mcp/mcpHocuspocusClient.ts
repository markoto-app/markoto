import jwt from 'jsonwebtoken'
import { mcpClientUserId, type SessionJwtPayload } from '~~/shared/contracts/jwt'
import { checkout, release, type PoolKey } from './yDocPool'
import type { ToolContext, ToolStatusPhase } from '../agentic/toolContext'
import { resolveBillingContext } from '../billing/billing'
import { resolveAiProviders } from '../aiProviders/resolve'
import type { DocAccess, UserScope, WorkspaceAccess } from '../../repos/proofs'
import { useValkey } from '../platform/valkey'
import { useEnv } from '~~/shared/env/load'
import { apiError } from '../api/apiError'

// MCP equivalent of `createAiSession`. Builds a `ToolContext`-shaped
// handle for a single MCP tool call, backed by the YDocPool so
// repeated calls within the same MCP session reuse one provider.
//
// Lifecycle per tool call:
//
//   const { ctx, release: releasePool } = await connectAsMcpClient({
//     docId, userId, mcpSessionId, userName
//   })
//   try {
//     return await TOOL_HANDLERS[name](ctx, args)
//   } finally {
//     releasePool()
//   }
//
// The pool's idle eviction (5 min after refCount hits 0) keeps a warm
// provider around between calls in the same session, so a Claude
// Desktop conversation that issues several `view_document` /
// `replace_text` calls on the same doc only pays the ~200-500ms
// handshake cost once.

export interface ConnectAsMcpClientInput {
  /** The doc being acted on. Caller MUST authz-check this against
   *  `userId` BEFORE calling — `connectAsMcpClient` trusts what it
   *  gets. */
  docId: string
  /** Real human user id resolved from the PAT verifier. Used for
   *  audited writes (uploads.uploaderId, themes.user_id), billing
   *  attribution, and the mcp_sessions join. */
  userId: number
  /** MCP session id from the toolkit's `Mcp-Session-Id` header. One
   *  per Claude Desktop / Cursor connection. Stable across all tool
   *  calls in the session so the pool dedupes per-session. */
  mcpSessionId: string
  /** Display name for the awareness `user.name` field — what live
   *  collaborators see in the presence bar. Sourced from the PAT
   *  owner's `users.name`. */
  userName: string
  /** Optional color for the awareness `user.color` field. Falls back
   *  to a desaturated default. */
  userColor?: string
  /** The workspace the doc belongs to (or `null` for standalone docs),
   *  from the wrapper's access decision. */
  workspaceId: string | null
  /** The wrapper's proof for the document (`view` or `edit` per tool). */
  docAccess: DocAccess<'view'>
  /** The token owner acting for themselves. */
  self: UserScope
  /** The token owner's membership of `workspaceId` (null for guests and outsiders). */
  workspaceAccess: WorkspaceAccess<'member'> | null
}

export interface McpClientHandle {
  /** Loop-agnostic tool surface — pass to `TOOL_HANDLERS[name]`. */
  ctx: ToolContext
  /** Release the underlying pool entry. MUST be called in a `finally`
   *  to avoid pinning the provider. Idempotent — safe to call twice. */
  release(): void
}

const DEFAULT_MCP_COLOR = '#7A8B99'

// Per-user cap on simultaneously open MCP doc connections. Stops a
// misbehaving Claude-Desktop / Cursor / script from opening hundreds
// of pool entries faster than the 5-min idle eviction can clear them.
// 10 distinct docs is comfortable headroom for a productive multi-doc
// session — more is almost certainly a runaway loop.
const MAX_OPEN_DOCS_PER_USER = 10
// 10-min TTL on the reservation set so a user that died mid-call
// (process crash before release) doesn't get permanently capped.
const USER_OPEN_DOCS_TTL_SECONDS = 10 * 60

function userOpenDocsKey(userId: number): string {
  return `mcp:user-open-docs:${userId}`
}

/**
 * Reserve a slot in the user's "open docs" set. Returns `true` if the
 * reservation succeeded (or was already held — re-entrant calls for the
 * same docId are no-ops); `false` if the user is at cap.
 *
 * Implementation: Valkey SET semantics make SADD on a duplicate a no-op
 * (returns 0). We only enforce the cap when the addition was new.
 */
async function reserveUserDocSlot(userId: number, docId: string): Promise<boolean> {
  try {
    const valkey = useValkey()
    const key = userOpenDocsKey(userId)
    const added = await valkey.sadd(key, docId)
    await valkey.expire(key, USER_OPEN_DOCS_TTL_SECONDS)
    if (added === 0) return true // already reserved — re-entry, no cap charge
    const count = await valkey.scard(key)
    if (count > MAX_OPEN_DOCS_PER_USER) {
      // Roll back the addition so the user isn't permanently over by 1.
      await valkey.srem(key, docId)
      return false
    }
    return true
  } catch {
    // Fail OPEN on Valkey errors — same polarity as `checkRateLimit`.
    // The cap is anti-abuse, not correctness; a degraded Valkey
    // shouldn't lock all MCP traffic out.
    return true
  }
}

async function releaseUserDocSlot(userId: number, docId: string): Promise<void> {
  try {
    const valkey = useValkey()
    await valkey.srem(userOpenDocsKey(userId), docId)
  } catch {
    // Non-fatal — the TTL on the set will eventually clean it up.
  }
}

function mintMcpJwt(docId: string, mcpSessionId: string): string {
  const env = useEnv()
  if (!env.auth.jwtSecret) throw new Error('JWT secret not configured')
  const payload: SessionJwtPayload = {
    docId,
    userId: mcpClientUserId(mcpSessionId),
    // Friendly literal for `activity_log.user_name` — same pattern
    // as the in-app AI loop's `'markoto'`. The synthetic principal
    // (for joining `activity_log` rows back to `mcp_sessions` and
    // resolving the human initiator) lives in
    // `activity_log.actor_principal` column, which the sync-server
    // populates from the JWT's `userId` field directly. See
    // `server/db/schema/collab.ts` activity_log.actor_principal comment.
    userName: 'MCP',
    readOnly: false
  }
  // 10m TTL — matches the AI loop's JWT TTL. A pool entry can stay
  // connected longer (it's evicted by refCount, not by expiry): the pool
  // calls this minter again whenever the sync server asks for a fresh
  // token or the provider reconnects.
  return jwt.sign(payload, env.auth.jwtSecret, { expiresIn: '10m' })
}

export async function connectAsMcpClient(input: ConnectAsMcpClientInput): Promise<McpClientHandle> {
  const env = useEnv()
  const syncUrl = env.sync.internalUrl.replace(/^http(s?):\/\//, 'ws$1://')

  // Per-user cap. Reserved BEFORE the pool checkout so a misbehaving
  // client can't hold N+1 in-flight checkouts that all eventually
  // succeed past the cap. The reservation is rolled back on any
  // downstream failure path AND on `release()`.
  const reserved = await reserveUserDocSlot(input.userId, input.docId)
  if (!reserved) {
    throw apiError('mcp/too-many-open-docs', { max: MAX_OPEN_DOCS_PER_USER })
  }

  // Pool key — per-MCP-session principal so multiple Claude Desktop
  // tool calls in one conversation share a single provider.
  const key: PoolKey = {
    docId: input.docId,
    principalId: `mcp:${input.mcpSessionId}`
  }

  // Resolve billing context once per call. The MCP tool handlers
  // (especially anything hitting LiteLLM — web_search, fetch_url,
  // generate_image, knowledge embeddings) read `virtualKey` /
  // `attributedTo` / `plan` off the ToolContext and pass them to
  // `useLitellmForUser(virtualKey)`. Resolving HERE rather than
  // baking into the pool entry means a mid-session plan change is
  // picked up on the NEXT tool call (vs frozen forever).
  const workspaceId = input.workspaceId
  const billingContext = await resolveBillingContext(input.userId, workspaceId)
  // BYOK providers, resolved per call like the billing context so a
  // settings change is picked up on the next tool call.
  const aiProviders = await resolveAiProviders(input.self, billingContext.plan)

  let entry
  try {
    entry = await checkout(key, {
      jwt: () => mintMcpJwt(input.docId, input.mcpSessionId),
      awarenessUser: {
        name: input.userName,
        color: input.userColor ?? DEFAULT_MCP_COLOR
        // `isAI: false` (default) — the avatar uses the user's color
        // and name. We tag the principal in awareness extras below so
        // live collaborators can see "via Claude Desktop".
      },
      awarenessExtra: {
        mcpSession: {
          mcpSessionId: input.mcpSessionId,
          userId: input.userId
        },
        mcpStatus: { phase: 'thinking' as const, message: null }
      },
      syncUrl
    })
  } catch (err) {
    // Pool checkout failed (sync timeout, auth fail, transport
    // close) — release the user-doc reservation so the cap doesn't
    // leak. The error propagates to the wrapper which surfaces it as
    // an MCP isError response.
    await releaseUserDocSlot(input.userId, input.docId)
    throw err
  }

  // Only the status kind is broadcast: awareness reaches every participant of the document,
  // and status messages can name the user's other documents, queries or
  // URLs. The MCP client learns the details from the tool result.
  const updateStatus = (phase: ToolStatusPhase, _message?: string): void => {
    entry.awareness.setLocalStateField('mcpStatus', { phase, message: null })
  }

  let released = false
  const releaseOnce = (): void => {
    if (released) return
    released = true
    release(key)
    void releaseUserDocSlot(input.userId, input.docId)
  }

  const ctx: ToolContext = {
    docId: input.docId,
    initiatorUserId: input.userId,
    workspaceId,
    self: input.self,
    docAccess: input.docAccess,
    workspaceAccess: input.workspaceAccess,
    ydoc: entry.ydoc,
    ytext: entry.ytext,
    ymeta: entry.ymeta,
    awareness: entry.awareness,
    sessionId: input.mcpSessionId,
    attributedTo: billingContext.attributedTo,
    plan: billingContext.plan,
    periodStart: billingContext.periodStart,
    virtualKey: billingContext.virtualKey,
    aiProviders,
    updateStatus
  }

  return { ctx, release: releaseOnce }
}
