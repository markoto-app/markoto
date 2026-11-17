// Access proofs: the values repo functions demand before they write, delete
// or return tenant-private data. A proof says WHO acts (the actor) and WHAT
// was proven for WHICH object; the repo takes the object id from the proof,
// so the id in the query is the id that was authorized.
//
// Construction is closed. Every constructor takes the module-private `MINT`
// token, typed as its own unique symbol, so `new DocAccess(...)` does not
// type-check outside this file (and throws at runtime if forced); a member
// keyed by an undeclared unique symbol (or a `#private` field) makes the
// types nominal, so an object literal never type-checks as a proof. Only
// `server/utils/access/**` may import this file (dependency-cruiser +
// ESLint); everything else imports the types from `./index.ts`. What is left
// is lying to the compiler (a cast, an `any` / `never` value, a ts-comment),
// which lint refuses: `markoto/no-proof-forgery` and `ban-ts-comment`.
//
// The one constructor outside the access layer is `system(name)`: a named
// background job (sweeper, webhook, worker) that acts on whatever it is
// given. It is greppable by name and banned from user-facing handlers by an
// ESLint rule.

const MINT: unique symbol = Symbol('access-proof')
declare const CAN: unique symbol
declare const BRAND: unique symbol

function checkToken(token: typeof MINT): void {
  if (!Object.is(token, MINT)) throw new Error('access proofs are minted by server/utils/access only')
}

/** Every named background actor. Add a name when a new job needs one. */
export const SYSTEM_ACTORS = [
  'account-deletion',
  'account-deletion-sweep',
  'ad-conversions',
  'admin-bootstrap',
  'ai-jobs',
  'ai-jobs-sweep',
  'ai-records-sweep',
  'ai-session',
  'ai-spend-rollup',
  'analytics-retention-sweep',
  'comment-trigger',
  'custom-domain-recheck',
  'data-export-expiry-sweep',
  'data-export-worker',
  'design-import',
  'image-gc',
  'inactive-doc-sweep',
  'internal-render',
  'knowledge-pipeline',
  'knowledge-sweep',
  'legal-retention-sweep',
  'litellm-reconcile',
  'live-dictation',
  'mcp-sessions-sweep',
  'moderation',
  'orphan-cleanup',
  'publish-pages',
  'scim',
  'spend-logs-sweep',
  'sso-login',
  'stripe-webhook',
  'sync-server',
  'test-harness',
  'waitlist-sweep',
  'workspace-billing',
  'workspace-invite-sweep'
] as const
export type SystemName = typeof SYSTEM_ACTORS[number]

/** Who acts. Recorded as the audit actor; `anonymous` only reaches open documents. */
export type Actor
  = | { readonly kind: 'user', readonly userId: number }
    | { readonly kind: 'anonymous' }
    | { readonly kind: 'admin', readonly userId: number }
    | { readonly kind: 'system', readonly name: SystemName }

// ---------- documents ----------

/**
 * What was proven on a document. `view` (read it), `write` (change its
 * content: what a writable editor token allows), `edit` (owner / workspace
 * editor: title, theme, context), `manage` (owner / workspace admin: sharing,
 * password, move), `share` (workspace admin / editor: guest shares),
 * `delete`.
 */
export type DocLevel = 'view' | 'write' | 'edit' | 'manage' | 'share' | 'delete'

const DOC_IMPLIES = {
  view: ['view'],
  write: ['view', 'write'],
  edit: ['view', 'write', 'edit'],
  manage: ['view', 'write', 'edit', 'manage'],
  share: ['view', 'share'],
  delete: ['delete']
} as const satisfies Record<DocLevel, readonly DocLevel[]>

/** The levels a proof of `L` carries: a manage proof is also an edit, write and view proof. */
export type DocGrant<L extends DocLevel> = typeof DOC_IMPLIES[L][number]

/**
 * `DocAccess<'manage'>` is also a write, edit and view proof: the phantom
 * member lists the implied levels, so a repo function asking for
 * `DocAccess<'view'>` accepts any proof that includes viewing.
 */
export class DocAccess<L extends DocLevel = never> {
  readonly #levels: ReadonlySet<DocLevel>
  declare readonly [CAN]: { readonly [K in DocGrant<L>]: true }
  readonly docId: string
  readonly actor: Actor

  constructor(token: typeof MINT, docId: string, actor: Actor, levels: Iterable<DocLevel>) {
    checkToken(token)
    if (typeof docId !== 'string' || docId === '') throw new Error('DocAccess needs a document id')
    this.docId = docId
    this.actor = actor
    this.#levels = closeDocLevels(levels)
    Object.freeze(this)
  }

  /** Narrow to a level the access layer granted at runtime (a `lookup` route deciding per field). */
  allows<M extends DocLevel>(level: M): this is DocAccess<L | DocGrant<M>> {
    return this.#levels.has(level)
  }
}

function closeDocLevels(levels: Iterable<DocLevel>): ReadonlySet<DocLevel> {
  const out = new Set<DocLevel>()
  for (const level of levels) for (const implied of DOC_IMPLIES[level]) out.add(implied)
  return out
}

// ---------- workspaces ----------

export type WorkspaceLevel = 'member' | 'editor' | 'admin'
export type WorkspaceMemberRole = 'viewer' | 'editor' | 'admin'

const WS_IMPLIES = {
  member: ['member'],
  editor: ['member', 'editor'],
  admin: ['member', 'editor', 'admin']
} as const satisfies Record<WorkspaceLevel, readonly WorkspaceLevel[]>

export type WorkspaceGrant<L extends WorkspaceLevel> = typeof WS_IMPLIES[L][number]

const ROLE_LEVEL: Record<WorkspaceMemberRole, WorkspaceLevel> = { viewer: 'member', editor: 'editor', admin: 'admin' }

export class WorkspaceAccess<L extends WorkspaceLevel = never> {
  readonly #levels: ReadonlySet<WorkspaceLevel>
  declare readonly [CAN]: { readonly [K in WorkspaceGrant<L>]: true }
  readonly workspaceId: string
  readonly actor: Actor

  constructor(token: typeof MINT, workspaceId: string, actor: Actor, level: WorkspaceLevel) {
    checkToken(token)
    if (typeof workspaceId !== 'string' || workspaceId === '') throw new Error('WorkspaceAccess needs a workspace id')
    this.workspaceId = workspaceId
    this.actor = actor
    this.#levels = new Set(WS_IMPLIES[level])
    Object.freeze(this)
  }

  allows<M extends WorkspaceLevel>(level: M): this is WorkspaceAccess<L | WorkspaceGrant<M>> {
    return this.#levels.has(level)
  }
}

// ---------- users ----------

/** Acting on one user's own data: the user themselves, an admin or a named job. */
export class UserScope {
  declare readonly [BRAND]: 'user-scope'
  readonly userId: number
  readonly actor: Actor

  constructor(token: typeof MINT, userId: number, actor: Actor) {
    checkToken(token)
    if (!Number.isInteger(userId) || userId <= 0) throw new Error('UserScope needs a user id')
    this.userId = userId
    this.actor = actor
    Object.freeze(this)
  }

  /** The user acts on their own data (not an admin or a job on their behalf). */
  get isSelf(): boolean {
    return this.actor.kind === 'user' && this.actor.userId === this.userId
  }
}

// ---------- elevated actors ----------

/**
 * An actor that may act on any object: an instance admin (minted by the
 * admin policy) or a named job (`system(name)`). Each derived proof records
 * this actor, so the audit trail says who it was.
 */
abstract class Elevated {
  abstract readonly actor: Actor
  doc(docId: string): DocAccess<DocLevel> {
    return new DocAccess<DocLevel>(MINT, docId, this.actor, ['manage', 'share', 'delete'])
  }

  workspace(workspaceId: string): WorkspaceAccess<WorkspaceLevel> {
    return new WorkspaceAccess<WorkspaceLevel>(MINT, workspaceId, this.actor, 'admin')
  }

  user(userId: number): UserScope {
    return new UserScope(MINT, userId, this.actor)
  }
}

export class AdminActor extends Elevated {
  declare readonly [BRAND]: 'admin'
  readonly actor: Actor
  readonly userId: number

  constructor(token: typeof MINT, userId: number) {
    super()
    checkToken(token)
    this.userId = userId
    this.actor = { kind: 'admin', userId }
    Object.freeze(this)
  }
}

export class SystemActor extends Elevated {
  declare readonly [BRAND]: 'system'
  readonly actor: Actor
  readonly name: SystemName

  /**
   * A job carrying out what a user asked for (a queued data export, the
   * SSO sign-in that user just completed): the user is the actor of record,
   * as when they act in a request.
   */
  actingFor(userId: number): UserScope {
    return new UserScope(MINT, userId, { kind: 'user', userId })
  }

  constructor(token: typeof MINT, name: SystemName) {
    super()
    checkToken(token)
    if (!SYSTEM_ACTORS.includes(name)) throw new Error(`unknown system actor ${String(name)}`)
    this.name = name
    this.actor = { kind: 'system', name }
    Object.freeze(this)
  }
}

/** A named background job. Greppable on purpose: `system('<name>')`. */
export function system(name: SystemName): SystemActor {
  return new SystemActor(MINT, name)
}

// ---------- minting (access layer only) ----------

export function userActor(userId: number | null): Actor {
  return userId === null ? { kind: 'anonymous' } : { kind: 'user', userId }
}

/** A document proof for the levels the access layer decided; fails closed when `need` is not among them. */
export function mintDocAccess<N extends DocLevel>(actor: Actor, docId: string, granted: Iterable<DocLevel>, need: N): DocAccess<DocGrant<N>> {
  const proof = new DocAccess<never>(MINT, docId, actor, granted)
  if (!proof.allows(need)) throw new Error(`mintDocAccess: ${need} was not granted`)
  return proof
}

/** A document proof whose level the handler decides per field (`allow.doc('lookup')`): narrow with `allows`. */
export function mintDocLookup(actor: Actor, docId: string, granted: Iterable<DocLevel>): DocAccess {
  return new DocAccess(MINT, docId, actor, granted)
}

/** A workspace proof for a member's role; fails closed when the role is below `need`. */
export function mintWorkspaceAccess<N extends WorkspaceLevel>(actor: Actor, workspaceId: string, role: WorkspaceMemberRole, need: N): WorkspaceAccess<WorkspaceGrant<N>> {
  const proof = new WorkspaceAccess<never>(MINT, workspaceId, actor, ROLE_LEVEL[role])
  if (!proof.allows(need)) throw new Error(`mintWorkspaceAccess: ${role} does not satisfy ${need}`)
  return proof
}

/** A signed-in user acting on their own data. */
export function mintUserScope(userId: number): UserScope {
  return new UserScope(MINT, userId, { kind: 'user', userId })
}

/** An instance admin (`users.is_admin`), minted by the admin policy only. */
export function mintAdminActor(userId: number): AdminActor {
  return new AdminActor(MINT, userId)
}
