import { listWorkspaceAuditEvents } from '../../../../repos/audit'
import { auditEventView, auditRetentionDays } from '../../../../utils/workspaces/workspaceAudit'
import { listAuditEventsQuery } from '~~/shared/api/legal'

const PAGE = 50

// GET /api/workspaces/:wsId/audit?before=<id>&action=<prefix>&from=&to=
// — the workspace's audit log for its admins, newest first.
// `nextBefore` is the cursor for the next page (null at the end).
export default defineApiHandler({
  access: allow.workspace('admin', { deny: 'audit/admin-required' }),
  plan: { feature: 'auditLog', message: 'The audit log is part of the Business plan.' },
  query: listAuditEventsQuery,
  invalidCode: 'audit/invalid-query',
  handler: async ({ event, wsId, query }) => {
    const rows = await listWorkspaceAuditEvents(wsId, { beforeId: query.before, actionPrefix: query.action, from: query.from, to: query.to, limit: PAGE + 1 })
    const page = rows.slice(0, PAGE)
    setHeader(event, 'cache-control', 'private, no-store')
    return {
      events: page.map(auditEventView),
      nextBefore: rows.length > PAGE ? page.at(-1)!.id : null,
      retentionDays: auditRetentionDays()
    }
  }
})
