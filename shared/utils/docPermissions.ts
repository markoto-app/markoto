// Pure authorization decisions for per-document access.
//
// These functions are the single source of truth for "who can do what to
// which doc". They take already-loaded state (doc row + actor context) and
// return a decision. No DB queries, no side effects — so every cell of the
// (accessMode × role × ownership) matrix is directly unit-testable without
// spinning up a server.
//
// Endpoints are thin wrappers: they fetch state, call the relevant decide*
// function, and translate the outcome to HTTP. Calling code that needs the
// raw booleans (e.g. the workspaces invariant check) keeps using the DB
// helpers in server/utils/workspaceAccess.ts — those exist for server-side
// convenience, not as policy authority.

export type AccessMode = 'private' | 'open-edit' | 'open-view' | 'password-protected'
export type WorkspaceRole = 'admin' | 'editor' | 'viewer'
/**
 * A row in `workspace_members` (WP11): a role, or `guest` — someone who
 * reaches only the documents shared with them. Never passed to the
 * access decisions as a role: `getMemberRole` returns null for a guest,
 * and the document query maps a share to `editor` / `viewer`.
 */
export type MembershipRole = WorkspaceRole | 'guest'

export interface DocState {
  ownerId: number | null
  workspaceId: string | null
  accessMode: AccessMode
}

export interface ActorState {
  // null = anonymous request (no session cookie, or cookie cleared).
  userId: number | null
  // Actor's role in the doc's workspace. null = not a member, or the doc has
  // no workspace, or the actor is anonymous. Callers must resolve this from
  // workspace_members before calling the decision function.
  workspaceRole: WorkspaceRole | null
  // True when the request presents a valid JWT whose `docId` claim matches
  // the doc being accessed. This is the only path for an anonymous user who
  // verified a document password to reach restricted-mode files / activity.
  // Only meaningful for the view-level decisions (file, activity); the token
  // endpoint never sees this (that's where the JWT comes *from*).
  hasValidDocJwt?: boolean
  // True when the request carries the creator key of an anonymous doc
  // (the browser that created it, see `server/utils/anonCreator.ts`).
  // Only read by `decideDocDelete`: anonymous docs can be deleted only
  // by their creating browser.
  isAnonCreator?: boolean
}

export type TokenOutcome = 'allow' | 'forbidden' | 'password-required'
export interface TokenDecision {
  outcome: TokenOutcome
  // True when the granted access is view-only. Set on 'allow' and (as a
  // safety default) also on 'forbidden' / 'password-required' outcomes,
  // where no token is issued anyway.
  readOnly: boolean
}

export type ViewOutcome = 'allow' | 'deny'
export interface ViewDecision {
  outcome: ViewOutcome
}

export type DeleteOutcome = 'allow' | 'deny'
export interface DeleteDecision {
  outcome: DeleteOutcome
  // Human-readable reason. Not exposed to clients verbatim — endpoints
  // translate to generic 401/403 messages to avoid leaking authz shape.
  reason?: string
}

// Small helpers kept private so the decision functions read top-to-bottom.
function isDocOwner(doc: DocState, actor: ActorState): boolean {
  return doc.ownerId !== null && actor.userId !== null && doc.ownerId === actor.userId
}

function hasFullMembership(doc: DocState, actor: ActorState): boolean {
  // "Full" = can edit content. Owner + workspace admin + workspace editor.
  if (isDocOwner(doc, actor)) return true
  return actor.workspaceRole === 'admin' || actor.workspaceRole === 'editor'
}

function hasAnyMembership(doc: DocState, actor: ActorState): boolean {
  // "Any" = at least viewer-level membership. Includes viewers.
  if (hasFullMembership(doc, actor)) return true
  return actor.workspaceRole === 'viewer'
}

function isAnonymousDoc(doc: DocState): boolean {
  // Anonymous doc invariant: no owner and no workspace. Created by an
  // unauthenticated user; accessMode is always 'open-edit' because there's
  // no stable identity to scope any other mode to (see docs.post.ts).
  return doc.ownerId === null && doc.workspaceId === null
}

/**
 * Decide what Y.js connection token (if any) to issue for a given
 * (doc, actor) pair. This is the decision layer for the
 * `GET /api/docs/:id/token` endpoint.
 *
 * - `allow`              → mint a JWT with the returned readOnly flag
 * - `forbidden`          → return { token: null, forbidden: true }
 * - `password-required`  → return { token: null, requiresPassword: true }
 *
 * Spec (AGENTS.md §4):
 *   - Doc owner: full access, always.
 *   - Workspace admin/editor: bypass `private` and `password-protected`,
 *     get full edit on all modes.
 *   - Workspace viewer: bypass `private` and `password-protected`, but
 *     capped to read-only on every mode.
 *   - Non-member / anonymous: fall through to accessMode rules.
 */
export function decideTokenAccess(doc: DocState, actor: ActorState): TokenDecision {
  const owner = isDocOwner(doc, actor)
  const isViewer = actor.workspaceRole === 'viewer'
  const full = hasFullMembership(doc, actor)
  const any = hasAnyMembership(doc, actor)

  switch (doc.accessMode) {
    case 'private': {
      if (!any) {
        return { outcome: 'forbidden', readOnly: true }
      }
      return { outcome: 'allow', readOnly: !full }
    }

    case 'open-edit': {
      // Workspace viewer role wins over the public edit grant — a viewer
      // of the enclosing workspace stays read-only even on an open-edit doc.
      // Owner-in-viewer-role edge case: owner beats role (hasFullMembership).
      if (isViewer && !owner) {
        return { outcome: 'allow', readOnly: true }
      }
      return { outcome: 'allow', readOnly: false }
    }

    case 'open-view': {
      return { outcome: 'allow', readOnly: !full }
    }

    case 'password-protected': {
      // Workspace members (any role) bypass the password. Viewers stay
      // read-only; admins/editors/owner get full edit.
      if (any) {
        return { outcome: 'allow', readOnly: !full }
      }
      return { outcome: 'password-required', readOnly: true }
    }
  }
}

/**
 * Decide whether to issue a presigned S3 URL for a file on this doc.
 *
 * View-level gate — no readOnly distinction because files are served via
 * 302 and aren't written through here.
 *
 * Rules:
 *   - open-edit / open-view  → public (no check; anyone who can reach the
 *     endpoint can see the doc contents anyway).
 *   - private                → owner, any workspace role, or valid JWT.
 *   - password-protected     → owner, any workspace role, or valid JWT.
 *
 * The JWT path covers anonymous users who verified a document password —
 * they have no session cookie but do hold a scoped JWT from /password.
 */
export function decideFileAccess(doc: DocState, actor: ActorState): ViewDecision {
  if (doc.accessMode === 'open-edit' || doc.accessMode === 'open-view') {
    return { outcome: 'allow' }
  }
  // private or password-protected
  if (isDocOwner(doc, actor)) return { outcome: 'allow' }
  if (actor.workspaceRole !== null) return { outcome: 'allow' }
  if (actor.hasValidDocJwt) return { outcome: 'allow' }
  return { outcome: 'deny' }
}

/**
 * Decide whether to return the activity log for a doc. Same shape as file
 * access — the activity log reveals edit times and userNames, so it's
 * at least as sensitive as the file contents.
 */
export function decideActivityAccess(doc: DocState, actor: ActorState): ViewDecision {
  // Intentionally delegates — same threat model as file access.
  return decideFileAccess(doc, actor)
}

/**
 * Decide whether a delete is allowed.
 *
 * Rules:
 *   - Anonymous doc (no owner, no workspace, open-edit): only the
 *     browser that created it, proven by its creator key
 *     (`actor.isAnonCreator`). Everyone else with the link can still
 *     edit the doc, but not delete it. Legacy anonymous docs without a
 *     stored key can't be deleted through the API; the inactive-doc
 *     sweep removes them.
 *   - Owned standalone doc: only the owner.
 *   - Workspace doc: owner OR workspace admin.
 *   - Editor-own case: a workspace editor who is also the doc owner
 *     deletes via the owner path.
 */
export function decideDocDelete(doc: DocState, actor: ActorState): DeleteDecision {
  if (isAnonymousDoc(doc)) {
    // Defensive: accessMode could theoretically be anything, but in
    // practice anon docs are always open-edit (see docs.post.ts). Refusing
    // delete on unexpected anon modes is safer than allowing.
    if (doc.accessMode !== 'open-edit') {
      return { outcome: 'deny', reason: 'anon-doc-in-unexpected-mode' }
    }
    if (actor.isAnonCreator === true) {
      return { outcome: 'allow' }
    }
    return { outcome: 'deny', reason: 'not-anon-creator' }
  }

  if (isDocOwner(doc, actor)) {
    return { outcome: 'allow' }
  }
  if (actor.workspaceRole === 'admin') {
    return { outcome: 'allow' }
  }

  if (actor.userId === null) {
    return { outcome: 'deny', reason: 'authentication-required' }
  }
  return { outcome: 'deny', reason: 'not-authorized' }
}
