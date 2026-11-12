import { appendAuditEvent, listWorkspaceAuditEvents } from '../../../../repos/audit'
import { AUDIT_WORKSPACE_AUDIT_EXPORTED } from '../../../../legal/auditActions'
import { auditCsvHeader, auditCsvLine, auditEventView } from '../../../../utils/workspaces/workspaceAudit'
import { HOUR_MS } from '~~/shared/config/units'
import { exportAuditEventsQuery } from '~~/shared/api/legal'

const BATCH = 1000
const MAX_ROWS = 100_000

// GET /api/workspaces/:wsId/audit/export?format=csv|jsonl&from=&to=&action=
// — download the workspace's audit log. Admins of a plan with the
// audit log; 10 exports / admin / hour; at most 100 000 rows (narrow the
// dates beyond that); the export itself is audited.
export default defineApiHandler({
  access: allow.workspace('admin', { deny: 'audit/admin-required' }),
  plan: { feature: 'auditLog', message: 'The audit log is part of the Business plan.' },
  query: exportAuditEventsQuery,
  invalidCode: 'audit/invalid-query',
  rateLimit: { namespace: 'audit-export', max: 10, windowMs: HOUR_MS, key: 'user', error: 'audit/rate-limited' },
  handler: async ({ event, wsId, query: q, workspaceAccess }) => {
    const format = q.format ?? 'csv'
    const query = { actionPrefix: q.action, from: q.from, to: q.to }

    const chunks: string[] = format === 'csv' ? [auditCsvHeader()] : []
    let before: number | undefined
    let total = 0
    for (;;) {
      const rows = await listWorkspaceAuditEvents(workspaceAccess, { ...query, beforeId: before, limit: BATCH })
      for (const row of rows) {
        const view = auditEventView(row)
        chunks.push(format === 'csv' ? auditCsvLine(view) : `${JSON.stringify(view)}\n`)
      }
      total += rows.length
      if (rows.length < BATCH) break
      if (total > MAX_ROWS) {
        throw apiError('audit/too-many-rows', { max: MAX_ROWS })
      }
      before = rows.at(-1)?.id
    }

    await appendAuditEvent({
      by: workspaceAccess,
      actorIp: getClientIp(event),
      scope: 'workspace',
      scopeId: wsId,
      action: AUDIT_WORKSPACE_AUDIT_EXPORTED,
      metadata: { format, rows: total, from: query.from?.toISOString() ?? null, to: query.to?.toISOString() ?? null }
    })
    const stamp = new Date().toISOString().slice(0, 10)
    setHeader(event, 'content-type', format === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson; charset=utf-8')
    setHeader(event, 'content-disposition', `attachment; filename="audit-log-${wsId}-${stamp}.${format}"`)
    setHeader(event, 'cache-control', 'private, no-store')
    return chunks.join('')
  }
})
