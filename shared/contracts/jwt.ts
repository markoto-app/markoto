/**
 * Shared JWT payload contracts.
 *
 * Every JWT we mint OR verify in this codebase has its TS shape
 * defined here. Mint sites annotate their payload `satisfies` the
 * shared interface; verify sites narrow incoming payloads to the
 * shared interface. A drift on either side becomes a TypeScript
 * error at PR time.
 *
 * Without a shared type, a mint helper producing `{kind: 'dictate'}`
 * against a verifier checking `payload.scope === 'dictate'` fails with
 * misleading close-code errors; one definition prevents that.
 *
 * Naming convention: `<purpose>JwtPayload` for static shapes,
 * `<PURPOSE>_JWT_FIXED_CLAIMS` for any literal claims that MUST be
 * present (e.g. `kind: 'dictate'`). Mint sites spread the fixed
 * claims into their payload to guarantee the literal value lands.
 *
 * Three classes of token live here, distinguished by the `scope`
 * claim's presence:
 *   - SESSION-shaped (no `scope` claim): doc-token, ai-client,
 *     restore-client, comments-peek-client. All verified by
 *     sync-server's onAuthenticate hook. The auth REJECTS any token
 *     carrying a non-empty `scope` — defense-in-depth so a leaked
 *     dictate or render token can't be replayed against the WS sync.
 *   - SCOPED HTTP tokens: render (`scope: 'render'`), dictate
 *     (`scope: 'dictate'`). Verified by their respective HTTP
 *     handlers; rejected by sync-server's WS auth.
 *
 * The SYNTHETIC userId convention encodes the principal type without
 * needing a separate field:
 *   - `<numeric-id>` — real DB user
 *   - `'anonymous'` — unauthenticated session-grant (password unlock)
 *   - `'ai:assistant:<sessionId>'` — AI client (deterministic helper:
 *      `aiClientUserId`)
 *   - `'restore:<actorUserId>:<sessionId>'` — synthetic restore client
 *      (deterministic helper: `restoreClientUserId`)
 *   - `'comments-server:<verb>:<userId>'` — `openTrustedCommentClient`
 *      mutation principal (verbs: `trigger`, `delete`, `delete-reply`)
 *   - `'ai-cross-doc-read:<initiatorUserId>:<sessionId>'` —
 *      cross-doc-read peek client used by AI tools
 *
 * Comments-server / cross-doc-read principals are constructed inline at
 * the call sites because the verb is endpoint-specific; they don't get
 * a deterministic helper here. AI + restore principals DO get helpers
 * because their structure is stable and there are multiple call sites.
 *
 * Add new prefixes to SYNTHETIC_USER_ID_PREFIXES below if introducing
 * a new synthetic-client class.
 */

// Session-shaped JWTs (verified by sync-server onAuthenticate)

/**
 * Session-shaped JWT payload. Used for ALL Hocuspocus connections —
 * real users (via /api/docs/:id/token), AI clients, synthetic
 * restore clients, synthetic comments-peek clients. Distinguished
 * downstream by the userId convention (see SYNTHETIC_USER_ID_PATTERN).
 *
 * `scope` is intentionally absent from this shape: the verifier
 * REJECTS tokens that carry a non-empty `scope` (it'd indicate a
 * scoped HTTP token replayed at the WS path). Don't add `scope` here.
 */
export interface SessionJwtPayload {
  /** Required. Must equal the Hocuspocus documentName (verifier
   *  rejects mismatched docId — cross-doc replay guard). */
  docId: string
  /** Required. Numeric DB id for real users; the `<purpose>:<…>` form
   *  for synthetic clients. See SYNTHETIC_USER_ID_PATTERN. */
  userId: string | number
  /** Optional. Driven by JWT mint context. Activity-log attribution
   *  uses this when present; falls back to awareness heuristic. */
  userName?: string | null
  /** Optional. SAFE-DEFAULT IS READ-ONLY: a token must EXPLICITLY
   *  carry `readOnly: false` to get write access. The verifier
   *  treats absence/missing-field as read-only. */
  readOnly?: boolean
}

/** Synthetic-userId prefixes the verifier accepts. Add new prefixes
 *  here when a new synthetic-client class lands so consumers can
 *  pattern-match exhaustively. The literal `'anonymous'` is the
 *  password-unlock principal (no prefix — bare string). */
export const SYNTHETIC_USER_ID_PREFIXES = [
  'ai:assistant:',
  'restore:',
  'comments-server:',
  'ai-cross-doc-read:',
  // MCP tool calls — issued by `connectAsMcpClient` in
  // `server/utils/mcp/mcpHocuspocusClient.ts`. Each MCP session
  // (one Claude Desktop / Cursor connection) has a stable id;
  // every tool call from that session uses the same principal so
  // the YDocPool can dedupe per-session connections and so
  // activity-log rows stay attributable to the originating MCP
  // session. Real-user attribution is recoverable via the
  // `mcp_sessions` table.
  'mcp:'
] as const

/** Build the synthetic userId for an AI client session. Used by
 *  `server/utils/ai/aiClient.ts`. */
export function aiClientUserId(sessionId: string): `ai:assistant:${string}` {
  return `ai:assistant:${sessionId}`
}

/** Build the synthetic userId for a restore client session. Used by
 *  `server/utils/documents/restoreDoc.ts`. */
export function restoreClientUserId(actorUserId: number, sessionId: string): `restore:${number}:${string}` {
  return `restore:${actorUserId}:${sessionId}`
}

/** Build the synthetic userId for an MCP client session. Used by
 *  `server/utils/mcp/mcpHocuspocusClient.ts`. The mcpSessionId comes from
 *  the MCP toolkit's `Mcp-Session-Id` header (one per Claude Desktop
 *  / Cursor connection). */
export function mcpClientUserId(mcpSessionId: string): `mcp:${string}` {
  return `mcp:${mcpSessionId}`
}

// Scoped HTTP tokens

/**
 * Render token. Minted by `server/utils/rendering/renderTokens.ts` so the
 * renderer container can fetch the doc's bootstrap state (Y.js +
 * theme) over HTTP. Verified by the same module. The `scope: 'render'`
 * claim is REJECTED by the sync-server's WS auth — a leaked render
 * token cannot be replayed to join the live collab session.
 */
export interface RenderJwtPayload {
  docId: string
  /** `yjs_updates` id the renderer should reconstruct the document at. */
  snapshotId: number
  /** Constant: 'render'. Required. */
  scope: 'render'
}

/** Use as `{ ...RENDER_JWT_FIXED_CLAIMS, docId, snapshotId }` at
 *  the mint site so the literal scope value can never drift. */
export const RENDER_JWT_FIXED_CLAIMS = { scope: 'render' } as const

/** Lifetime of a render token. The renderer mints with the same value
 *  (`renderer/src/render.ts` cannot import `shared/`; its copy is pinned by
 *  tests/unit/platform/renderTokenTtl.test.ts). */
export const RENDER_TOKEN_TTL_SECONDS = 60

/**
 * Dictate token. Minted by `server/api/ai/dictate/token.post.ts` and
 * sent as the FIRST WS message on `/api/ai/dictate` (NOT the URL).
 * Verified inline in the dictate route. Both `kind` AND `scope` are
 * required — they're the same value but checked separately:
 *   - `kind === 'dictate'` is the "what kind of token is
 *     this" check.
 *   - `scope === 'dictate'` is the defense-in-depth check the
 *     sync-server WS auth uses to reject scoped tokens replayed at
 *     the WS sync path.
 * The aiDictateWs test helper missed `scope` for months — exactly
 * the kind of drift this file exists to prevent.
 */
export interface DictateJwtPayload {
  /** DB user id of the human invoking dictation. */
  userId: number
  /** Doc the dictation will write into. The dictate route doesn't
   *  enforce per-doc auth (the user already proved write access to
   *  this doc to obtain the token), but the field is carried for
   *  future per-doc routing. */
  docId: string
  /** Constant: 'dictate'. Required. */
  kind: 'dictate'
  /** Constant: 'dictate'. Required. Defense-in-depth — keeps a
   *  leaked dictate token from being replayed at the WS sync path
   *  (sync-server rejects any token with a non-empty `scope`). */
  scope: 'dictate'
}

/** Use as `{ ...DICTATE_JWT_FIXED_CLAIMS, userId, docId }` at the
 *  mint site. Tests must do the same. */
export const DICTATE_JWT_FIXED_CLAIMS = { kind: 'dictate', scope: 'dictate' } as const
