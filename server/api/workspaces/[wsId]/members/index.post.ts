import { findUserById } from '../../../../repos/users'
import { getWorkspace } from '../../../../repos/workspaces'
import {
  countOpenWorkspaceInvites,
  isEmailWorkspaceMember,
  upsertWorkspaceInvite
} from '../../../../repos/workspaceInvites'
import { appendAuditEvent } from '../../../../repos/audit'
import { countGuests, countMembers } from '../../../../repos/workspaceMembers'
import { assertPlanFeature, assertPlanLimit, resolveWorkspacePlan } from '../../../../utils/entitlements'
import { GUESTS_PER_SEAT } from '~~/shared/config/workspaceSeats'
import { AUDIT_WORKSPACE_BILLING_SEATS_CHANGED, AUDIT_WORKSPACE_INVITE_CREATED } from '../../../../legal/auditActions'
import { getPooledWorkspace, seatsFullError } from '../../../../utils/workspaceBilling'
import { acquireWorkspaceSeatLock, changeWorkspaceSeats, seatChangeError } from '../../../../utils/workspaceStripe'
import { ensureWorkspaceTeam } from '../../../../utils/litellm/workspaceTeams'
import { useStripeClient } from '../../../../utils/stripeClient'
import { notifyWorkspaceAdmins } from '../../../../utils/email/workspaceBillingEmails'
import { safeSendTransactionalEmail } from '../../../../utils/email/sendEmail'
import { emailLinkBaseUrl } from '../../../../utils/siteUrl'
import {
  WORKSPACE_INVITE_EMAILS_PER_ADDRESS,
  WORKSPACE_INVITE_EMAIL_WINDOW_MS,
  WORKSPACE_INVITE_OPEN_CAP,
  WORKSPACE_INVITE_PER_ADMIN_LIMIT,
  WORKSPACE_INVITE_PER_WORKSPACE_LIMIT,
  WORKSPACE_INVITE_TTL_MS,
  WORKSPACE_INVITE_WINDOW_MS,
  buildWorkspaceInviteEmail,
  generateInviteToken,
  hashInviteSecret,
  isInviteRole,
  normaliseInviteEmail,
  normaliseInviteLocale
} from '../../../../utils/workspaceInvites'

// POST /api/workspaces/:wsId/members — invite someone by email. Admin-only.
//
// Creates (or refreshes) a PENDING invite; nobody becomes a member here.
// The invitee accepts in-app (the invite matches the verified email on
// their account) or through the emailed link — see
// `/api/user/invites/*`. So:
//   - The response is the same `202 { ok: true }` whether or not the
//     address belongs to an account, and carries no profile data (no
//     account-existence / PII oracle).
//   - Only an address that is ALREADY a member of this workspace is
//     refused (409) — the admin can see the member list anyway.
//
// Abuse limits: per-admin and per-workspace hourly rate limits (429), a
// cap on open invites per workspace (409 `workspace/invite-cap`), and at
// most 3 invite emails per address per day (beyond that the invite is
// still recorded but no email goes out — same 202).
export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const wsId = requireWsId(event)
  const body = await readBody<{ email?: unknown, role?: unknown, addSeat?: unknown }>(event)

  const role = await getWorkspaceRole(session.user.id, wsId)
  if (role === null) throw createError({ statusCode: 404, message: 'Workspace not found' })
  if (role !== 'admin') {
    throw createError({ statusCode: 403, message: 'Only admins can invite members' })
  }

  const email = normaliseInviteEmail(body?.email)
  if (!email) {
    throw createError({
      statusCode: 400,
      message: 'Invalid email address',
      data: { code: 'workspace/invalid-email', messageKey: 'workspace.members.errors.invalidEmail' }
    })
  }

  // Default role for new invites is 'editor' — the most common case.
  const newRole = body?.role === undefined ? 'editor' : body.role
  if (!isInviteRole(newRole)) {
    throw createError({ statusCode: 400, message: 'Invalid role' })
  }

  const userKey = String(session.user.id)
  if (!(await checkRateLimit('workspace-invite-user', userKey, WORKSPACE_INVITE_PER_ADMIN_LIMIT, WORKSPACE_INVITE_WINDOW_MS))
    || !(await checkRateLimit('workspace-invite-ws', wsId, WORKSPACE_INVITE_PER_WORKSPACE_LIMIT, WORKSPACE_INVITE_WINDOW_MS))) {
    throw createError({
      statusCode: 429,
      message: 'Too many invitations. Try again later.',
      data: { code: 'workspace/invite-rate-limited', messageKey: 'error.rateLimited' }
    })
  }

  if (await isEmailWorkspaceMember(wsId, email)) {
    throw createError({
      statusCode: 409,
      message: 'Already a member of this workspace',
      data: { code: 'workspace/already-member', messageKey: 'workspace.members.errors.alreadyMember' }
    })
  }

  const now = new Date()
  const openInvites = await countOpenWorkspaceInvites(wsId, now, email)
  if (openInvites >= WORKSPACE_INVITE_OPEN_CAP) {
    throw createError({
      statusCode: 409,
      message: `A workspace can have at most ${WORKSPACE_INVITE_OPEN_CAP} open invitations.`,
      data: { code: 'workspace/invite-cap', messageKey: 'workspace.members.errors.inviteCap', limit: WORKSPACE_INVITE_OPEN_CAP }
    })
  }

  const plan = await resolveWorkspacePlan(wsId)

  // Team / Business: counting the seats and acting on the count (buying
  // one, writing the invite) happen under one lock per workspace, so two
  // admins inviting at once can't both take the last seat or both buy the
  // same one. The pool is re-read under the lock.
  const releaseSeatLock = await getPooledWorkspace(wsId, now) ? await acquireWorkspaceSeatLock(wsId) : null
  const baseUrl = emailLinkBaseUrl(useRuntimeConfig(event).siteUrl)
  let inviteId: string
  let token: string | null
  try {
    const pool = await getPooledWorkspace(wsId, now)

    if (newRole === 'guest') {
      // Guests (WP11): a plan feature; no seat and no member limit, but at
      // most GUESTS_PER_SEAT per paid seat in a Team / Business workspace.
      assertPlanFeature(plan, 'guests', 'Guests are part of the Team and Business plans.')
      if (pool) {
        const guests = await countGuests(wsId) + await countOpenWorkspaceInvites(wsId, now, email, 'guests')
        const cap = GUESTS_PER_SEAT * pool.seats
        if (guests >= cap) {
          throw createError({
            statusCode: 409,
            message: `This workspace can have at most ${cap} guests (${GUESTS_PER_SEAT} per paid seat).`,
            data: { code: 'workspace/guest-cap', messageKey: 'workspace.members.errors.guestCap', limit: cap }
          })
        }
      }
    }

    // Plan limit: people in the workspace = members + open invitations
    // (re-inviting the same address doesn't count twice — the count above
    // excludes it). Invitations count from the moment they're sent, so an
    // accepted invite never pushes a workspace past its limit and accepting
    // needs no second check. A workspace already above the limit (e.g.
    // after a downgrade) keeps everyone; only new invitations are refused.
    // Guests and guest invitations don't count (WP11).
    const membersNow = await countMembers(wsId)
    const memberInvites = await countOpenWorkspaceInvites(wsId, now, email, 'members')
    if (newRole !== 'guest') {
      assertPlanLimit(
        plan,
        'membersPerWorkspace',
        membersNow + memberInvites,
        'This workspace has reached the member limit of its plan.'
      )
    }

    // Team / Business (WP3): members + open invitations may not exceed the
    // paid seats. With `addSeat: true` (the invite dialog's "This adds a
    // seat" confirmation) one seat is bought and paid first, pro rata.
    if (pool && newRole !== 'guest') {
      const used = membersNow + memberInvites
      if (used >= pool.seats) {
        if (body?.addSeat !== true) throw seatsFullError(pool.seats, used)
        const stripe = useStripeClient()
        if (!stripe) throw createError({ statusCode: 503, message: 'Billing is not configured. Contact support.' })
        const seats = used + 1
        try {
          await changeWorkspaceSeats(stripe, pool.subscription, seats)
        } catch (e) {
          throw seatChangeError(e, wsId)
        }
        const updated = await getPooledWorkspace(wsId)
        if (updated) {
          await ensureWorkspaceTeam(updated).catch((e: unknown) => {
            console.warn(`[invite] team budget sync failed: ${e instanceof Error ? e.message : e}`)
          })
        }
        await appendAuditEvent({
          actorUserId: session.user.id,
          actorIp: getClientIp(event),
          scope: 'billing',
          scopeId: wsId,
          action: AUDIT_WORKSPACE_BILLING_SEATS_CHANGED,
          before: { seats: pool.seats },
          after: { seats },
          metadata: { reason: 'invite' }
        })
        // The billing admin pays: tell them when another admin added a seat.
        const billingAdminId = pool.subscription.billingAdminId
        if (billingAdminId !== null && billingAdminId !== session.user.id) {
          void notifyWorkspaceAdmins({
            workspaceId: wsId,
            kind: 'seat_added',
            onlyUserIds: [billingAdminId],
            vars: { seats, actor: session.user.name }
          })
        }
      }
    }

    // Email link only when the deployment has a configured site URL (links
    // are never built from the request Host) and the per-address daily
    // budget isn't spent. Without it the invite is in-app only.
    const sendEmail = baseUrl !== null
      && await checkRateLimit('workspace-invite-email', hashInviteSecret(email), WORKSPACE_INVITE_EMAILS_PER_ADDRESS, WORKSPACE_INVITE_EMAIL_WINDOW_MS)
    token = sendEmail ? generateInviteToken() : null

    inviteId = await upsertWorkspaceInvite({
      workspaceId: wsId,
      email,
      role: newRole,
      invitedByUserId: session.user.id,
      tokenHash: token === null ? null : hashInviteSecret(token),
      expiresAt: new Date(now.getTime() + WORKSPACE_INVITE_TTL_MS)
    })
  } finally {
    await releaseSeatLock?.()
  }

  if (token !== null && baseUrl !== null) {
    const [inviter, workspace] = await Promise.all([findUserById(session.user.id), getWorkspace(wsId)])
    const content = buildWorkspaceInviteEmail({
      locale: normaliseInviteLocale(inviter?.locale),
      baseUrl,
      token,
      inviterName: inviter?.name ?? session.user.name,
      workspaceName: workspace?.name ?? '',
      role: newRole
    })
    // Fire-and-forget like every transactional email; the invite is
    // committed and visible in-app regardless.
    void safeSendTransactionalEmail({
      kind: 'workspace.invite',
      to: email,
      locale: normaliseInviteLocale(inviter?.locale),
      subject: content.subject,
      body: content.body,
      bodyContainsSecrets: true
    })
  }

  await appendAuditEvent({
    actorUserId: session.user.id,
    actorIp: getClientIp(event),
    scope: 'workspace',
    scopeId: wsId,
    action: AUDIT_WORKSPACE_INVITE_CREATED,
    before: null,
    after: null,
    metadata: { inviteId, role: newRole, emailed: token !== null }
  })

  setResponseStatus(event, 202)
  return { ok: true, invited: true }
})
