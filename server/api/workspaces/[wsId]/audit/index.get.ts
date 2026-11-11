import { listWorkspaceAuditEvents } from '../../../../repos/audit'
import { auditEventView, auditRetentionDays, parseAuditQuery, requireAuditLogAccess } from '../../../../utils/workspaces/workspaceAudit'

const PAGE = 50

// GET /api/workspaces/:wsId/audit?before=<id>&action=<prefix>&from=&to=
// — the workspace's audit log for its admins, newest first (WP15).
// `nextBefore` is the cursor for the next page (null at the end).
export default defineEventHandler(async (event) => {
  const { wsId } = await requireAuditLogAccess(event)
  const query = parseAuditQuery(getQuery(event))
  const rows = await listWorkspaceAuditEvents(wsId, { ...query, limit: PAGE + 1 })
  const page = rows.slice(0, PAGE)
  setHeader(event, 'cache-control', 'private, no-store')
  return {
    events: page.map(auditEventView),
    nextBefore: rows.length > PAGE ? page.at(-1)!.id : null,
    retentionDays: auditRetentionDays()
  }
})
