import * as Sentry from '@sentry/nuxt'
import { getWorkspaceSubscription } from '../../../../repos/workspaceSubscriptions'
import { appendAuditEvent } from '../../../../repos/audit'
import { assertBillingEnabled } from '../../../../utils/billing/billingMode'
import { useStripeClient } from '../../../../utils/billing/stripeClient'
import type { H3Event } from 'h3'
import { acquireWorkspaceSeatLock, changeWorkspaceSeats, seatChangeError } from '../../../../utils/billing/workspaceStripe'
import { countSeatsUsed, getPooledWorkspace, parseSeats, requireWorkspaceBillingAdmin } from '../../../../utils/billing/workspaceBilling'
import { ensureWorkspaceTeam } from '../../../../utils/litellm/workspaceTeams'
import { AUDIT_WORKSPACE_BILLING_SEATS_CHANGED } from '../../../../legal/auditActions'
import { notifyWorkspaceAdmins } from '../../../../utils/email/workspaceBillingEmails'

// POST /api/workspaces/:wsId/billing/seats — change the paid seat count
// of a live Team / Business subscription. Workspace admins only.
// Body: {seats}. More seats are charged now, pro rata (402
// `billing/payment-failed` when the payment fails — nothing changes);
// fewer seats are not credited for the running period
// (`workspaceStripe.ts#changeWorkspaceSeats`). Seats can't go below
// members + open invitations (409 `billing/seats-below-members`). The
// pooled AI budget follows at once: added seats for the days left in the
// budget window, removed seats keep theirs until it ends.
export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  assertBillingEnabled()
  const wsId = requireWsId(event)
  await requireWorkspaceBillingAdmin(session.user.id, wsId)

  if (!(await checkRateLimit('billing-seats', String(session.user.id), 10, 60_000))) {
    throw createError({ statusCode: 429, message: 'Too many seat changes. Try again in a minute.', data: { code: 'billing/rate-limited', messageKey: 'error.rateLimited' } })
  }

  const body = await readBody<{ seats?: unknown }>(event)
  const seats = parseSeats(body?.seats)
  // Same lock as invitations: the seats-in-use count and the change can't
  // interleave with an invite taking a seat.
  const releaseSeatLock = await acquireWorkspaceSeatLock(wsId)
  try {
    return await changeSeats(event, session.user, wsId, seats)
  } finally {
    await releaseSeatLock()
  }
})

async function changeSeats(event: H3Event, user: { id: number, name: string }, wsId: string, seats: number): Promise<{ seats: number }> {
  const row = await getWorkspaceSubscription(wsId)
  if (!row?.stripeSubscriptionId) {
    throw createError({ statusCode: 409, message: 'This workspace has no subscription to change.', data: { code: 'billing/no-subscription' } })
  }
  if (seats === row.seats) return { seats }
  const used = await countSeatsUsed(wsId)
  if (seats < used) {
    throw createError({
      statusCode: 409,
      message: `${used} seats are in use (members and open invitations). Remove someone before reducing the seats.`,
      data: { code: 'billing/seats-below-members', used, messageKey: 'workspace.billing.errors.seatsBelowMembers' }
    })
  }

  const stripe = useStripeClient()
  if (!stripe) throw createError({ statusCode: 503, message: 'Billing is not configured. Contact support.' })
  try {
    await changeWorkspaceSeats(stripe, row, seats)
  } catch (e) {
    throw seatChangeError(e, wsId)
  }

  const pool = await getPooledWorkspace(wsId)
  if (pool) {
    await ensureWorkspaceTeam(pool).catch((e: unknown) => {
      Sentry.captureException(e, { tags: { component: 'billing', event: 'workspace_team_sync_failed', workspaceId: wsId } })
    })
  }
  await appendAuditEvent({
    actorUserId: user.id,
    actorIp: getClientIp(event),
    scope: 'billing',
    scopeId: wsId,
    action: AUDIT_WORKSPACE_BILLING_SEATS_CHANGED,
    before: { seats: row.seats },
    after: { seats },
    metadata: undefined
  })
  // More seats bought by an admin who isn't the billing admin: tell the
  // one who pays.
  if (seats > row.seats && row.billingAdminId !== null && row.billingAdminId !== user.id) {
    void notifyWorkspaceAdmins({ workspaceId: wsId, kind: 'seat_added', onlyUserIds: [row.billingAdminId], vars: { seats, actor: user.name } })
  }
  return { seats }
}
