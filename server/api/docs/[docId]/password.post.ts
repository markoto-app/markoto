import type { H3Event } from 'h3'
import jwt from 'jsonwebtoken'
import { getDoc, setDocPassword, clearDocPassword, type DocSnapshot, type DocAuthzRow } from '../../../repos/documents'
import { appendAuditEvent } from '../../../repos/audit'
import { admitPasswordAttempt, recordPasswordFailure } from '../../../utils/documents/docPasswordLimits'
import { decideTokenAccess, type ActorState, type DocState } from '../../../../shared/utils/documents/docPermissions'
import { docJwtLifetimeSeconds } from '../../../utils/documents/docJwt'
import { DOC_PASSWORD_MIN_LENGTH } from '../../../../shared/config/docPassword'
import { assertNotModerationRestricted } from '../../../utils/privacy/moderationRestriction'
import { notifySyncReauthDocument } from '../../../utils/documents/syncNotify'
import { docPasswordBody } from '~~/shared/api/docs'
import type { ValidatedUser } from '../../../utils/api/policyTypes'
import { useEnv } from '~~/shared/env/load'

// POST /api/docs/:docId/password — `{ action: 'set' | 'verify' | 'remove', password? }`.
// Verify is open to anyone who has the link (brute-force limited below);
// set and remove need a session and manage rights (owner, workspace admin).
export default defineApiHandler({
  access: allow.doc('lookup', {
    anonymous: true,
    reason: 'verify: anyone, limited per client+doc, per doc and by a per-doc failure lockout; set / remove: signed in with manage rights (checked per action)'
  }),
  body: docPasswordBody,
  handler: async ({ event, user, docId, doc: row, state, actor, authz, body }) => {
    const doc = await getDoc(docId)
    if (!doc) throw apiError('docs/not-found')

    if (body.action === 'verify') return handleVerify(event, user, docId, doc, row, state, actor, body.password)

    // Set and remove change who can open the document: owner or workspace
    // admin only (`canManage`). Editors / viewers cannot.
    if (!user) throw apiError('auth/required')
    if (!authz.canManage) throw apiError('docs/manage-forbidden')
    // A password opens the document to whoever has it; removing it makes the
    // document open-edit. Neither while a moderation restriction holds.
    assertNotModerationRestricted(doc)
    if (body.action === 'set') return handleSet(event, user, docId, doc, body.password)
    return handleRemove(event, user, docId, doc)
  }
})

async function handleSet(event: H3Event, user: ValidatedUser, docId: string, doc: DocSnapshot, password: string | undefined) {
  // Minimum length applies when a password is SET; passwords set under
  // an older, shorter minimum keep verifying.
  if (password === undefined || password.length < DOC_PASSWORD_MIN_LENGTH) {
    throw apiError('password/too-short', { minLength: DOC_PASSWORD_MIN_LENGTH })
  }

  const hash = await hashPassword(password)
  await setDocPassword(docId, hash)
  // Visitors connected without the (new) password must not stay in.
  notifySyncReauthDocument(docId)

  // Never log the password itself — record presence + access-mode
  // transition only. `setDocPassword` flips access_mode to
  // password-protected, so the after-state always has hasPassword=true.
  await appendAuditEvent({
    actorUserId: user.id,
    actorIp: getClientIp(event),
    scope: 'doc',
    scopeId: docId,
    action: 'doc.password_set',
    workspaceId: doc.workspaceId,
    before: { accessMode: doc.accessMode, hasPassword: !!doc.passwordHash },
    after: { accessMode: 'password-protected', hasPassword: true }
  })

  return { success: true }
}

/**
 * VERIFY password — anyone, brute-force limited (see
 * `utils/docPasswordLimits.ts`: per client(/64)+doc, per doc, and a
 * per-doc failure budget).
 *
 * Only meaningful while the doc IS password-protected: a hash left over
 * from an earlier password mode must never unlock a doc that is now
 * private / open-view (the hash is also cleared on mode change, this is
 * the belt to that brace). The granted access follows the same rule as
 * the token endpoint: the password stands in for "non-member on an
 * open-edit doc" (edit), while a workspace viewer stays read-only.
 */
async function handleVerify(
  event: H3Event,
  user: ValidatedUser | null,
  docId: string,
  doc: DocSnapshot,
  row: DocAuthzRow,
  state: DocState,
  actor: ActorState,
  password: string | undefined
) {
  const outcome = await admitPasswordAttempt(getClientRateLimitKey(event), docId)
  if (outcome !== 'allowed') {
    throw apiError(outcome === 'locked' ? 'password/locked' : 'password/rate-limited')
  }

  if (!password) {
    throw apiError('password/required')
  }
  if (doc.accessMode !== 'password-protected' || !doc.passwordHash) {
    throw apiError('password/not-set')
  }

  const valid = await verifyPassword(doc.passwordHash, password)
  if (!valid) {
    await recordPasswordFailure(docId)
    throw apiError('password/invalid')
  }

  const grant = passwordGrant(row, state, actor)
  return { success: true, token: mintPasswordToken(user, docId, grant.readOnly, grant.shareExpiresAt), readOnly: grant.readOnly }
}

/**
 * Read-only flag for a verified caller, derived from `decideTokenAccess`
 * so the two token surfaces can't disagree: a member who already has
 * access keeps exactly that access (viewer → read-only); the password's
 * audience ("password-required") gets edit. Anyone else — above all a
 * visitor once the share link has expired, when the doc counts as
 * private — is refused: the password no longer opens it.
 */
function passwordGrant(row: DocAuthzRow, state: DocState, actor: ActorState): { readOnly: boolean, shareExpiresAt: Date | null } {
  const decision = decideTokenAccess(state, actor)
  if (decision.outcome === 'allow') return { readOnly: decision.readOnly, shareExpiresAt: row.shareExpiresAt }
  if (decision.outcome === 'password-required') return { readOnly: false, shareExpiresAt: row.shareExpiresAt }
  throw apiError(state.shareExpired ? 'share/expired' : 'auth/forbidden')
}

/** Mint a doc JWT (≤ 2h, never past the share link's expiry) for a verified caller. Carries name for sync-server attribution — matches token.get.ts. */
function mintPasswordToken(user: ValidatedUser | null, docId: string, readOnly: boolean, shareExpiresAt: Date | null): string {
  const env = useEnv()
  if (!env.auth.jwtSecret) {
    throw apiError('internal')
  }
  return jwt.sign(
    {
      docId,
      userId: user?.id || 'anonymous',
      userName: user?.name ?? null,
      readOnly
    },
    env.auth.jwtSecret,
    { expiresIn: docJwtLifetimeSeconds(shareExpiresAt) }
  )
}

/** REMOVE password — doc owner or workspace admin. */
async function handleRemove(event: H3Event, user: ValidatedUser, docId: string, doc: DocSnapshot) {
  await clearDocPassword(docId)

  // `clearDocPassword` flips access_mode back to open-edit.
  await appendAuditEvent({
    actorUserId: user.id,
    actorIp: getClientIp(event),
    scope: 'doc',
    scopeId: docId,
    action: 'doc.password_removed',
    workspaceId: doc.workspaceId,
    before: { accessMode: doc.accessMode, hasPassword: !!doc.passwordHash },
    after: { accessMode: 'open-edit', hasPassword: false }
  })

  return { success: true }
}
