import type { H3Event } from 'h3'
import { findUserById } from '../repos/users'
import {
  acceptWorkspaceInvite,
  declineWorkspaceInvite,
  type InviteSelector
} from '../repos/workspaceInvites'
import { appendAuditEvent } from '../repos/audit'
import {
  AUDIT_WORKSPACE_INVITE_ACCEPTED,
  AUDIT_WORKSPACE_INVITE_DECLINED
} from '../legal/auditActions'
import { normaliseInviteEmail, parseInviteId } from './workspaceInvites'
import { getClientIp } from './clientIp'

// Invitee-side accept / decline, shared by the in-app endpoints
// (`/api/user/invites/:inviteId/{accept,decline}`) and the email-link
// endpoint (`/api/user/invites/by-token`).
//
// Proof that an invite belongs to the caller is either
//   - in-app: the invite's address equals the verified email on the
//     caller's account (accounts only ever store verified addresses), or
//   - email link: the caller presents the single-use token sent to that
//     address (possession of the mailbox).
// Anything else is a uniform 404 — an invite id alone grants nothing.

const NOT_FOUND = {
  statusCode: 404,
  message: 'Invitation not found or expired',
  data: { code: 'workspace/invite-not-found', messageKey: 'workspace.invites.errors.notFound' }
}

/** Selector for an in-app action on `:inviteId` by the signed-in user. */
export async function inAppInviteSelector(event: H3Event, userId: number): Promise<InviteSelector> {
  const inviteId = parseInviteId(getRouterParam(event, 'inviteId'))
  if (!inviteId) throw createError({ statusCode: 400, message: 'Invalid invite id' })
  const user = await findUserById(userId)
  const email = normaliseInviteEmail(user?.email)
  if (!email) throw createError(NOT_FOUND)
  return { kind: 'id', inviteId, email }
}

export async function acceptInviteForUser(event: H3Event, userId: number, selector: InviteSelector) {
  const accepted = await acceptWorkspaceInvite(selector, userId, new Date())
  if (!accepted) throw createError(NOT_FOUND)

  await appendAuditEvent({
    actorUserId: userId,
    actorIp: getClientIp(event),
    scope: 'workspace',
    scopeId: accepted.workspaceId,
    action: AUDIT_WORKSPACE_INVITE_ACCEPTED,
    before: null,
    after: { role: accepted.role },
    metadata: { inviteId: accepted.inviteId, via: selector.kind, alreadyMember: accepted.alreadyMember }
  })

  return {
    ok: true,
    workspaceId: accepted.workspaceId,
    workspaceName: accepted.workspaceName,
    role: accepted.role
  }
}

export async function declineInviteForUser(event: H3Event, userId: number, selector: InviteSelector) {
  const declined = await declineWorkspaceInvite(selector)
  if (!declined) throw createError(NOT_FOUND)

  await appendAuditEvent({
    actorUserId: userId,
    actorIp: getClientIp(event),
    scope: 'workspace',
    scopeId: declined.workspaceId,
    action: AUDIT_WORKSPACE_INVITE_DECLINED,
    before: null,
    after: null,
    metadata: { inviteId: declined.inviteId, via: selector.kind }
  })

  return { ok: true }
}
