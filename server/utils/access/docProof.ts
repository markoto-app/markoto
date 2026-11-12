import { getDocPasswordForVerify, getDocWithActorRole, getDocWorkspaceId, type DocAuthzRow } from '../../repos/access/docAuthz'
import { mintDocAccess, mintDocLookup, userActor, type Actor } from '../../repos/proofs/mint'
import type { DocAccess, DocGrant, DocLevel, UserScope, WorkspaceAccess } from '../../repos/proofs'
import { docAuthzOf } from './workspaceAccess'
import {
  decideActivityAccess,
  decideDocDelete,
  decideFileAccess,
  decideTokenAccess,
  docStateOf,
  type ActorState,
  type DocState
} from '~~/shared/utils/documents/docPermissions'

// Document decisions and the proofs they mint. `allow.doc(need)` (the HTTP
// policy), the MCP wrapper and the AI tools all decide here, on a row from
// `getDocWithActorRole`, with the pure functions of
// shared/utils/documents/docPermissions.ts. A proof carries every level the
// actor holds on the document at that moment; its static type carries the
// level the caller asked for.

export type { DocAuthzRow }
/** The access bootstrap lookup, for access decisions outside the HTTP policy. */
export { getDocWithActorRole }
/** The stored password, for the password check (access is what it grants). */
export { getDocPasswordForVerify }
/** A document's workspace (undefined: no such document), for decisions made before a proof exists (billing of a verified dictation token). */
export { getDocWorkspaceId }

/**
 * Can this logged-in user write to the document's CONTENT through a
 * server-side path (AI prompt, @ai comment trigger, restore, dictation,
 * image upload)? Same rule as the Y.js token the editor gets from
 * `GET /api/docs/:id/token`: `decideTokenAccess` granting a writable
 * token: so no endpoint can hand out more than the editor itself:
 *
 *   - doc owner, workspace admin/editor → yes, on every access mode
 *     (ownership of a doc in an SSO-enforcing workspace counts only while
 *     the user has an effective role there, `docStateOf`);
 *   - workspace viewer → no, even on `open-edit` docs (viewer wins over
 *     the public edit grant);
 *   - anyone else → only on `open-edit` docs.
 *
 * Password knowledge doesn't count here: these routes require a session,
 * and a password-protected doc's non-members get no server-side write
 * path (the password JWT only covers the Y.js connection).
 */
export function canWriteDocContent(row: DocAuthzRow, userId: number): boolean {
  const decision = decideTokenAccess(
    docStateOf(row),
    { userId, workspaceRole: row.workspaceRole }
  )
  return decision.outcome === 'allow' && !decision.readOnly
}

export type DocNeed = 'file' | 'activity' | 'write-content' | 'edit' | 'manage' | 'share-guests' | 'delete' | 'lookup'

export type DocDecision = { allow: true } | { allow: false, status: 401 | 403 }

/** `true` = allowed; `false` = 403; `401` = needs a signed-in caller. */
type Verdict = boolean | 401
type Rule = (row: DocAuthzRow, state: DocState, actor: ActorState) => Verdict

const RULES: Record<DocNeed, Rule> = {
  'lookup': () => true,
  'file': (_row, state, actor) => decideFileAccess(state, actor).outcome === 'allow',
  'activity': (_row, state, actor) => decideActivityAccess(state, actor).outcome === 'allow',
  'delete': (_row, state, actor) => {
    const d = decideDocDelete(state, actor)
    if (d.outcome === 'allow') return true
    return d.reason === 'authentication-required' ? 401 : false
  },
  'write-content': (row, _state, actor) => actor.userId === null ? 401 : canWriteDocContent(row, actor.userId),
  'edit': (row, _state, actor) => docAuthzOf(row, actor.userId).canEdit,
  'manage': (row, _state, actor) => docAuthzOf(row, actor.userId).canManage,
  // Workspace admins and editors (members, not guests) of a workspace doc.
  'share-guests': row => row.workspaceId !== null && !row.isGuest && (row.workspaceRole === 'admin' || row.workspaceRole === 'editor')
}

/** The proof level each need establishes (`lookup` establishes none: the handler narrows). */
const NEED_LEVEL = {
  'file': 'view',
  'activity': 'view',
  'write-content': 'write',
  'edit': 'edit',
  'manage': 'manage',
  'share-guests': 'share',
  'delete': 'delete'
} as const satisfies Record<Exclude<DocNeed, 'lookup'>, DocLevel>

/** The static grant a need yields. */
export type DocNeedGrant<N extends DocNeed> = N extends keyof typeof NEED_LEVEL ? DocGrant<typeof NEED_LEVEL[N]> : never

export function isDocNeed(need: unknown): need is DocNeed {
  return typeof need === 'string' && Object.hasOwn(RULES, need)
}

/**
 * Pure: may this actor do `need` on the document? Every rule delegates to a
 * docPermissions decision (or to `docAuthzOf` / `canWriteDocContent`, which
 * build on them). Unknown needs deny.
 */
export function decideDocNeed(need: DocNeed, row: DocAuthzRow, state: DocState, actor: ActorState): DocDecision {
  const verdict = isDocNeed(need) ? RULES[need](row, state, actor) : false
  if (verdict === true) return { allow: true }
  return { allow: false, status: verdict === 401 ? 401 : 403 }
}

/** Every level the actor holds on the document (the runtime content of a proof). */
function grantedDocLevels(row: DocAuthzRow, state: DocState, actor: ActorState): DocLevel[] {
  const levels: DocLevel[] = []
  for (const [need, level] of Object.entries(NEED_LEVEL) as Array<[keyof typeof NEED_LEVEL, DocLevel]>) {
    if (RULES[need](row, state, actor) === true) levels.push(level)
  }
  return levels
}

/**
 * The proof for a decision the caller has already made with `decideDocNeed`
 * on the same row and actor. Fails closed (throws) if `need` is not granted.
 */
export function docProofFor<N extends DocNeed>(need: N, docId: string, row: DocAuthzRow, state: DocState, actor: ActorState): DocAccess<DocNeedGrant<N>> {
  const who = userActor(actor.userId)
  const granted = grantedDocLevels(row, state, actor)
  // TS cannot narrow a generic N through the `lookup` check, so the
  // narrowing runs on a plain copy; the level is NEED_LEVEL[N] by construction.
  const plain: DocNeed = need
  if (plain === 'lookup') return mintDocLookup(who, docId, granted) as DocAccess<DocNeedGrant<N>>
  return mintDocAccess(who, docId, granted, NEED_LEVEL[plain])
}

/**
 * The membership grants an MCP token or cross-document AI tool works with:
 * `view` = owner or any workspace role (access mode not considered), `edit`
 * = owner, workspace admin or editor, `manage` = owner or workspace admin.
 * Null when missing or not granted.
 */
export async function proveDocMembership<K extends 'view' | 'edit' | 'manage'>(
  userId: number,
  docId: string,
  kind: K
): Promise<{ access: DocAccess<DocGrant<K>>, workspaceId: string | null, row: DocAuthzRow } | null> {
  const row = await getDocWithActorRole(docId, userId)
  if (!row) return null
  const authz = docAuthzOf(row, userId)
  const levels: DocLevel[] = []
  if (authz.canView) levels.push('view')
  if (authz.canEdit) levels.push('edit')
  if (authz.canManage) levels.push('manage')
  if (!levels.includes(kind)) return null
  const who: Actor = userActor(userId)
  return { access: mintDocAccess(who, docId, levels, kind), workspaceId: row.workspaceId, row }
}

/**
 * A document reached through its workspace: workspace admins hold
 * owner-equivalent rights over every document in it (manage, share,
 * delete), editors edit and share, every member views. The document must
 * belong to the proof's workspace, else null: a document id from another
 * workspace never yields a proof. Narrow the result with `allows`.
 */
export async function proveWorkspaceDoc(ws: WorkspaceAccess<'member'>, docId: string): Promise<DocAccess | null> {
  if ((await getDocWorkspaceId(docId)) !== ws.workspaceId) return null
  const levels: DocLevel[] = ['view']
  if (ws.allows('editor')) levels.push('edit', 'share')
  if (ws.allows('admin')) levels.push('manage', 'delete')
  return mintDocLookup(ws.actor, docId, levels)
}

/**
 * The internal print page: a render token (signed with the internal secret,
 * 60 s) names exactly one document, which the renderer may read.
 */
export function proveRenderDoc(docId: string): DocAccess<'view'> {
  return mintDocAccess({ kind: 'system', name: 'internal-render' }, docId, ['view'], 'view')
}

/**
 * A document the caller has just created (a duplicate, a template copy):
 * nobody else knows its id yet, so its creator holds every right on it.
 * Call only with the id of a row the caller itself inserted.
 */
export function proveNewDoc(creator: UserScope | null, docId: string): DocAccess<'manage' | 'share' | 'delete'> {
  return mintDocAccess(creator ? creator.actor : { kind: 'anonymous' }, docId, ['manage', 'share', 'delete'], 'manage') as DocAccess<'manage' | 'share' | 'delete'>
}
