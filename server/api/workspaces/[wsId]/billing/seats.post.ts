import * as Sentry from '@sentry/nuxt'
import { getWorkspaceSubscription } from '../../../../repos/workspaceSubscriptions'
import { appendAuditEvent } from '../../../../repos/audit'
import { useStripeClient } from '../../../../utils/billing/stripeClient'
import type { H3Event } from 'h3'
import { acquireWorkspaceSeatLock, changeWorkspaceSeats, seatChangeError } from '../../../../utils/billing/workspaceStripe'
import { countSeatsUsed, getPooledWorkspace, parseSeats } from '../../../../utils/billing/workspaceBilling'
import { ensureWorkspaceTeam } from '../../../../utils/litellm/workspaceTeams'
import { AUDIT_WORKSPACE_BILLING_SEATS_CHANGED } from '../../../../legal/auditActions'
import { notifyWorkspaceAdmins } from '../../../../utils/email/workspaceBillingEmails'
import { changeSeatsBody } from '~~/shared/api/billing'
import { MINUTE_MS } from '~~/shared/config/units'
import type { WorkspaceAccess } from '../../../../repos/proofs'

// POST /api/workspaces/:wsId/billing/seats: change the paid seat count
// of a live Team / Business subscription. Workspace admins only.
// Body: {seats}. More seats are charged now, pro rata (402
// `billing/payment-failed` when the payment fails, nothing changes);
// fewer seats are not credited for the running period
// (`workspaceStripe.ts#changeWorkspaceSeats`). Seats can't go below
// members + open invitations (409 `billing/seats-below-members`), and
// not change on a cancelled plan (409 `billing/plan-cancelled`). The
// pooled AI budget follows at once: added seats for the days left in the
// budget window, removed seats keep theirs until it ends.
export default defineApiHandler({
  access: allow.workspace('admin', { deny: 'billing/admin-required' }),
  instance: 'billing',
  body: changeSeatsBody,
  rateLimit: { namespace: 'billing-seats', max: 10, windowMs: MINUTE_MS, key: 'user', error: 'billing/rate-limited' },
  handler: async ({ event, user, wsId, body, workspaceAccess }) => {
    const seats = parseSeats(body?.seats)
    // Same lock as invitations: the seats-in-use count and the change can't
    // interleave with an invite taking a seat.
    const releaseSeatLock = await acquireWorkspaceSeatLock(wsId)
    try {
      return await changeSeats(event, user, workspaceAccess, seats)
    } finally {
      await releaseSeatLock()
    }
  }
})

async function changeSeats(event: H3Event, user: { id: number, name: string }, workspaceAccess: WorkspaceAccess<'admin'>, seats: number): Promise<{ seats: number }> {
  const wsId = workspaceAccess.workspaceId
  const row = await getWorkspaceSubscription(wsId)
  if (!row?.stripeSubscriptionId) {
    throw apiError('billing/no-subscription')
  }
  // A cancelled plan that still runs: seats bought now would be charged for
  // a plan that is about to end. Resume it first (the page hides the control).
  if (row.cancelAt !== null) throw apiError('billing/plan-cancelled')
  if (seats === row.seats) return { seats }
  const used = await countSeatsUsed(workspaceAccess)
  if (seats < used) {
    throw apiError('billing/seats-below-members', { used })
  }

  const stripe = useStripeClient()
  if (!stripe) throw apiError('billing/not-configured')
  try {
    await changeWorkspaceSeats(stripe, workspaceAccess, row, seats)
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
    by: workspaceAccess,
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
