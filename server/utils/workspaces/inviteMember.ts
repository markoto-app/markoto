import type { H3Event } from 'h3'
import type { PlanName } from '~~/shared/config/tiers'
import { findUserById } from '../../repos/users'
import { getWorkspace } from '../../repos/workspaces'
import { countOpenWorkspaceInvites, isEmailWorkspaceMember, upsertWorkspaceInvite } from '../../repos/workspaceInvites'
import { appendAuditEvent } from '../../repos/audit'
import { countGuests, countMembers } from '../../repos/workspaceMembers'
import { checkRateLimit } from '../platform/rateLimit'
import { getClientIp } from '../platform/clientIp'
import { apiError } from '../api/apiError'
import { assertPlanFeature, assertPlanLimit, resolveWorkspacePlan } from '../billing/entitlements'
import { GUESTS_PER_SEAT } from '~~/shared/config/workspaceSeats'
import { AUDIT_WORKSPACE_BILLING_SEATS_CHANGED, AUDIT_WORKSPACE_INVITE_CREATED } from '../../legal/auditActions'
import { getPooledWorkspace, seatsFullError, type PooledWorkspace } from '../billing/workspaceBilling'
import { acquireWorkspaceSeatLock, changeWorkspaceSeats, seatChangeError } from '../billing/workspaceStripe'
import { ensureWorkspaceTeam } from '../litellm/workspaceTeams'
import { useStripeClient } from '../billing/stripeClient'
import { notifyWorkspaceAdmins } from '../email/workspaceBillingEmails'
import { safeSendTransactionalEmail } from '../email/sendEmail'
import { emailLinkBaseUrl } from '../platform/siteUrl'
import {
  WORKSPACE_INVITE_EMAILS_PER_ADDRESS,
  WORKSPACE_INVITE_EMAIL_WINDOW_MS,
  WORKSPACE_INVITE_OPEN_CAP,
  WORKSPACE_INVITE_TTL_MS,
  buildWorkspaceInviteEmail,
  generateInviteToken,
  hashInviteSecret,
  normaliseInviteLocale
} from './workspaceInvites'
import { useEnv } from '~~/shared/env/load'
import { useLogger } from '../platform/logger'

const log = useLogger('workspace-invite')

// Inviting someone to a workspace by email (`POST /api/workspaces/:wsId/members`,
// admins only — the route checks the role, the address and the invite
// rate limits before calling this). Creates (or refreshes) a PENDING
// invite; nobody becomes a member here. Plan limits, the guest cap and
// Team / Business seats are enforced under one lock per workspace; the
// invite email (when the per-address budget allows) and the audit row
// follow.

type InviteRole = Parameters<typeof upsertWorkspaceInvite>[0]['role']

export interface WorkspaceInviteRequest {
  wsId: string
  inviter: { id: number, name: string }
  /** Normalised address (`normaliseInviteEmail`). */
  email: string
  role: InviteRole
  /** The invite dialog's "This adds a seat" confirmation. */
  addSeat: boolean
}

interface InviteContext extends WorkspaceInviteRequest {
  event: H3Event
  now: Date
  plan: PlanName
}

export async function inviteWorkspaceMember(event: H3Event, request: WorkspaceInviteRequest): Promise<void> {
  const { wsId, email } = request
  if (await isEmailWorkspaceMember(wsId, email)) {
    throw apiError('workspace/already-member')
  }

  const now = new Date()
  const openInvites = await countOpenWorkspaceInvites(wsId, now, email)
  if (openInvites >= WORKSPACE_INVITE_OPEN_CAP) {
    throw apiError('workspace/invite-cap', { limit: WORKSPACE_INVITE_OPEN_CAP })
  }

  const ctx: InviteContext = { ...request, event, now, plan: await resolveWorkspacePlan(wsId) }

  // Team / Business: counting the seats and acting on the count (buying
  // one, writing the invite) happen under one lock per workspace, so two
  // admins inviting at once can't both take the last seat or both buy the
  // same one. The pool is re-read under the lock.
  const releaseSeatLock = await getPooledWorkspace(wsId, now) ? await acquireWorkspaceSeatLock(wsId) : null
  const baseUrl = emailLinkBaseUrl(useEnv().core.siteUrl)
  let invite: { inviteId: string, token: string | null }
  try {
    const pool = await getPooledWorkspace(wsId, now)
    await assertRoomForInvitee(ctx, pool)
    invite = await recordInvite(ctx, baseUrl)
  } finally {
    await releaseSeatLock?.()
  }

  if (invite.token !== null && baseUrl !== null) {
    await sendInviteEmail(ctx, invite.token, baseUrl)
  }

  await appendAuditEvent({
    actorUserId: request.inviter.id,
    actorIp: getClientIp(event),
    scope: 'workspace',
    scopeId: wsId,
    action: AUDIT_WORKSPACE_INVITE_CREATED,
    before: null,
    after: null,
    metadata: { inviteId: invite.inviteId, role: request.role, emailed: invite.token !== null }
  })
}

/**
 * Plan feature + guest cap for guests; the plan's member limit and the
 * paid seats for everyone else (buying a seat when the admin confirmed).
 */
async function assertRoomForInvitee(ctx: InviteContext, pool: PooledWorkspace | null): Promise<void> {
  const { wsId, now, email, plan, role } = ctx
  if (role === 'guest') {
    // Guests: a plan feature; no seat and no member limit, but at
    // most GUESTS_PER_SEAT per paid seat in a Team / Business workspace.
    assertPlanFeature(plan, 'guests', 'Guests are part of the Team and Business plans.')
    if (pool) {
      const guests = await countGuests(wsId) + await countOpenWorkspaceInvites(wsId, now, email, 'guests')
      const cap = GUESTS_PER_SEAT * pool.seats
      if (guests >= cap) {
        throw apiError('workspace/guest-cap', { limit: cap })
      }
    }
  }

  // Plan limit: people in the workspace = members + open invitations
  // (re-inviting the same address doesn't count twice — the count above
  // excludes it). Invitations count from the moment they're sent, so an
  // accepted invite never pushes a workspace past its limit and accepting
  // needs no second check. A workspace already above the limit (e.g.
  // after a downgrade) keeps everyone; only new invitations are refused.
  // Guests and guest invitations don't count.
  const membersNow = await countMembers(wsId)
  const memberInvites = await countOpenWorkspaceInvites(wsId, now, email, 'members')
  if (role === 'guest') return
  assertPlanLimit(
    plan,
    'membersPerWorkspace',
    membersNow + memberInvites,
    'This workspace has reached the member limit of its plan.'
  )

  // Team / Business: members + open invitations may not exceed the
  // paid seats. With `addSeat: true` (the invite dialog's "This adds a
  // seat" confirmation) one seat is bought and paid first, pro rata.
  const used = membersNow + memberInvites
  if (pool && used >= pool.seats) {
    if (!ctx.addSeat) throw seatsFullError(pool.seats, used)
    await buySeat(ctx, pool, used + 1)
  }
}

/** One more seat on the workspace's subscription, paid pro rata, then its team budget and the billing admin. */
async function buySeat(ctx: InviteContext, pool: PooledWorkspace, seats: number): Promise<void> {
  const { wsId, inviter } = ctx
  const stripe = useStripeClient()
  if (!stripe) throw apiError('workspace/billing-not-configured')
  try {
    await changeWorkspaceSeats(stripe, pool.subscription, seats)
  } catch (e) {
    throw seatChangeError(e, wsId)
  }
  const updated = await getPooledWorkspace(wsId)
  if (updated) {
    await ensureWorkspaceTeam(updated).catch((e: unknown) => {
      log.warn('team budget sync failed', { err: e })
    })
  }
  await appendAuditEvent({
    actorUserId: inviter.id,
    actorIp: getClientIp(ctx.event),
    scope: 'billing',
    scopeId: wsId,
    action: AUDIT_WORKSPACE_BILLING_SEATS_CHANGED,
    before: { seats: pool.seats },
    after: { seats },
    metadata: { reason: 'invite' }
  })
  // The billing admin pays: tell them when another admin added a seat.
  const billingAdminId = pool.subscription.billingAdminId
  if (billingAdminId !== null && billingAdminId !== inviter.id) {
    void notifyWorkspaceAdmins({
      workspaceId: wsId,
      kind: 'seat_added',
      onlyUserIds: [billingAdminId],
      vars: { seats, actor: inviter.name }
    })
  }
}

/** Write the invite; its single-use email token only when the email will go out. */
async function recordInvite(ctx: InviteContext, baseUrl: string | null): Promise<{ inviteId: string, token: string | null }> {
  // Email link only when the deployment has a configured site URL (links
  // are never built from the request Host) and the per-address daily
  // budget isn't spent. Without it the invite is in-app only.
  const sendEmail = baseUrl !== null
    && await checkRateLimit('workspace-invite-email', hashInviteSecret(ctx.email), WORKSPACE_INVITE_EMAILS_PER_ADDRESS, WORKSPACE_INVITE_EMAIL_WINDOW_MS)
  const token = sendEmail ? generateInviteToken() : null

  const inviteId = await upsertWorkspaceInvite({
    workspaceId: ctx.wsId,
    email: ctx.email,
    role: ctx.role,
    invitedByUserId: ctx.inviter.id,
    tokenHash: token === null ? null : hashInviteSecret(token),
    expiresAt: new Date(ctx.now.getTime() + WORKSPACE_INVITE_TTL_MS)
  })
  return { inviteId, token }
}

async function sendInviteEmail(ctx: InviteContext, token: string, baseUrl: string): Promise<void> {
  const [inviter, workspace] = await Promise.all([findUserById(ctx.inviter.id), getWorkspace(ctx.wsId)])
  const content = buildWorkspaceInviteEmail({
    locale: normaliseInviteLocale(inviter?.locale),
    baseUrl,
    token,
    inviterName: inviter?.name ?? ctx.inviter.name,
    workspaceName: workspace?.name ?? '',
    role: ctx.role
  })
  // Fire-and-forget like every transactional email; the invite is
  // committed and visible in-app regardless.
  void safeSendTransactionalEmail({
    kind: 'workspace.invite',
    to: ctx.email,
    locale: normaliseInviteLocale(inviter?.locale),
    subject: content.subject,
    body: content.body,
    bodyContainsSecrets: true
  })
}
