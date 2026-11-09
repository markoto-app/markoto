import * as Sentry from '@sentry/nuxt'
import { getWorkspaceSubscription } from '../../../../repos/workspaceSubscriptions'
import { appendAuditEvent } from '../../../../repos/audit'
import { assertBillingEnabled } from '../../../../utils/billingMode'
import { useStripeClient } from '../../../../utils/stripeClient'
import { changeWorkspaceSeats } from '../../../../utils/workspaceStripe'
import { countSeatsUsed, getPooledWorkspace, parseSeats, requireWorkspaceBillingAdmin } from '../../../../utils/workspaceBilling'
import { ensureWorkspaceTeam } from '../../../../utils/litellm/workspaceTeams'
import { AUDIT_WORKSPACE_BILLING_SEATS_CHANGED } from '../../../../legal/auditActions'

// POST /api/workspaces/:wsId/billing/seats — change the paid seat count
// of a live Team / Business subscription (WP3). Workspace admins only.
// Body: {seats}. Prorated (`create_prorations`: more seats are charged on
// the next invoice, fewer are credited). Seats can't go below members +
// open invitations (409 `billing/seats-below-members`). The pooled AI
// budget follows at once.
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
    if ((e as { statusCode?: number })?.statusCode) throw e
    Sentry.captureException(e, { tags: { component: 'billing', event: 'workspace_seats_failed', workspaceId: wsId } })
    throw createError({ statusCode: 502, message: `Could not change the seats: ${e instanceof Error ? e.message : 'Stripe error'}` })
  }

  const pool = await getPooledWorkspace(wsId)
  if (pool) {
    await ensureWorkspaceTeam(pool).catch((e: unknown) => {
      Sentry.captureException(e, { tags: { component: 'billing', event: 'workspace_team_sync_failed', workspaceId: wsId } })
    })
  }
  await appendAuditEvent({
    actorUserId: session.user.id,
    actorIp: getClientIp(event),
    scope: 'billing',
    scopeId: wsId,
    action: AUDIT_WORKSPACE_BILLING_SEATS_CHANGED,
    before: { seats: row.seats },
    after: { seats },
    metadata: undefined
  })
  return { seats }
})
