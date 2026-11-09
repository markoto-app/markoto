import type { H3Event } from 'h3'
import { getDoc, getDocWithActorRole, setDocPassword, clearDocPassword, type DocSnapshot } from '../../../repos/documents'
import { appendAuditEvent } from '../../../repos/audit'
import { admitPasswordAttempt, recordPasswordFailure } from '../../../utils/docPasswordLimits'
import { decideTokenAccess } from '../../../../shared/utils/docPermissions'
import { DOC_PASSWORD_MIN_LENGTH } from '../../../../shared/config/docPassword'

export default defineEventHandler(async (event) => {
  const docId = requireDocId(event)
  const body = await readBody(event)
  const doc = await getDoc(docId)
  if (!doc) {
    throw createError({ statusCode: 404, message: 'Document not found' })
  }

  const { action, password } = body as { action: 'set' | 'verify' | 'remove', password?: string }

  if (action === 'set') return handleSet(event, docId, doc, password)
  if (action === 'verify') return handleVerify(event, docId, doc, password)
  if (action === 'remove') return handleRemove(event, docId, doc)
  throw createError({ statusCode: 400, message: 'Invalid action' })
})

/**
 * SET password — doc owner or workspace admin. `canManageDoc`
 * encapsulates the orthogonal "doc owner vs workspace admin" branches;
 * both can change access controls. Editors / viewers cannot.
 */
async function handleSet(event: H3Event, docId: string, doc: DocSnapshot, password: string | undefined) {
  const session = await requireValidatedUserSession(event)
  if (!(await canManageDoc(session.user.id, docId))) {
    throw createError({ statusCode: 403, message: 'Not authorized to manage this document' })
  }
  // Minimum length applies when a password is SET; passwords set under
  // an older, shorter minimum keep verifying.
  if (typeof password !== 'string' || password.length < DOC_PASSWORD_MIN_LENGTH) {
    throw createError({
      statusCode: 400,
      message: `Password must be at least ${DOC_PASSWORD_MIN_LENGTH} characters`,
      data: { code: 'password/too-short', minLength: DOC_PASSWORD_MIN_LENGTH }
    })
  }

  const hash = await hashPassword(password)
  await setDocPassword(docId, hash)

  // Never log the password itself — record presence + access-mode
  // transition only. `setDocPassword` flips access_mode to
  // password-protected, so the after-state always has hasPassword=true.
  await appendAuditEvent({
    actorUserId: session.user.id,
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
async function handleVerify(event: H3Event, docId: string, doc: DocSnapshot, password: string | undefined) {
  const outcome = await admitPasswordAttempt(getClientRateLimitKey(event), docId)
  if (outcome !== 'allowed') {
    throw createError({
      statusCode: 429,
      message: 'Too many attempts. Try again later.',
      data: {
        code: outcome === 'locked' ? 'password/locked' : 'password/rate-limited',
        messageKey: 'error.rateLimited'
      }
    })
  }

  if (!password) {
    throw createError({ statusCode: 400, message: 'Password required' })
  }
  if (doc.accessMode !== 'password-protected' || !doc.passwordHash) {
    throw createError({ statusCode: 400, message: 'Document has no password' })
  }

  const valid = await verifyPassword(doc.passwordHash, password)
  if (!valid) {
    await recordPasswordFailure(docId)
    throw createError({
      statusCode: 401,
      message: 'Invalid password',
      data: { code: 'password/invalid' }
    })
  }

  const readOnly = await passwordGrantReadOnly(event, docId)
  return { success: true, token: await mintPasswordToken(event, docId, readOnly), readOnly }
}

/**
 * Read-only flag for a verified caller, derived from `decideTokenAccess`
 * so the two token surfaces can't disagree: a member who already has
 * access keeps exactly that access (viewer → read-only); anyone else is
 * treated as the password's audience and gets edit.
 */
async function passwordGrantReadOnly(event: H3Event, docId: string): Promise<boolean> {
  const session = await getValidatedUserSession(event)
  const userId = session?.user?.id ?? null
  const row = await getDocWithActorRole(docId, userId)
  if (!row) throw createError({ statusCode: 404, message: 'Document not found' })
  const decision = decideTokenAccess(
    { ownerId: row.ownerId, workspaceId: row.workspaceId, accessMode: row.accessMode },
    { userId, workspaceRole: row.workspaceRole }
  )
  return decision.outcome === 'allow' ? decision.readOnly : false
}

/** Mint a 2h doc JWT for a verified caller. Carries name for sync-server attribution — matches token.get.ts. */
async function mintPasswordToken(event: H3Event, docId: string, readOnly: boolean): Promise<string> {
  const jwt = await import('jsonwebtoken')
  const config = useRuntimeConfig()
  if (!config.jwtSecret) {
    throw createError({ statusCode: 500, message: 'JWT secret not configured' })
  }
  const session = await getValidatedUserSession(event)
  return jwt.default.sign(
    {
      docId,
      userId: session?.user?.id || 'anonymous',
      userName: session?.user?.name ?? null,
      readOnly
    },
    config.jwtSecret,
    { expiresIn: '2h' }
  )
}

/** REMOVE password — doc owner or workspace admin. */
async function handleRemove(event: H3Event, docId: string, doc: DocSnapshot) {
  const session = await requireValidatedUserSession(event)
  if (!(await canManageDoc(session.user.id, docId))) {
    throw createError({ statusCode: 403, message: 'Not authorized to manage this document' })
  }

  await clearDocPassword(docId)

  // `clearDocPassword` flips access_mode back to open-edit.
  await appendAuditEvent({
    actorUserId: session.user.id,
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
