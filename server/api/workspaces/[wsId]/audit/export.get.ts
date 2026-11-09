import { appendAuditEvent, listWorkspaceAuditEvents } from '../../../../repos/audit'
import { AUDIT_WORKSPACE_AUDIT_EXPORTED } from '../../../../legal/auditActions'
import { auditCsvHeader, auditCsvLine, auditEventView, parseAuditQuery, requireAuditLogAccess } from '../../../../utils/workspaceAudit'

const BATCH = 1000
const MAX_ROWS = 100_000

// GET /api/workspaces/:wsId/audit/export?format=csv|jsonl&from=&to=&action=
// — download the workspace's audit log (WP15). Admins of a plan with the
// audit log; 10 exports / admin / hour; at most 100 000 rows (narrow the
// dates beyond that); the export itself is audited.
export default defineEventHandler(async (event) => {
  const { userId, wsId } = await requireAuditLogAccess(event)
  const q = getQuery(event)
  const format = q.format === 'jsonl' ? 'jsonl' : q.format === undefined || q.format === 'csv' ? 'csv' : null
  if (!format) throw createError({ statusCode: 400, message: 'Format is csv or jsonl.', data: { code: 'audit/invalid-query', field: 'format' } })
  const query = parseAuditQuery({ ...q, before: undefined })
  if (!(await checkRateLimit('audit-export', String(userId), 10, 60 * 60_000))) {
    throw createError({ statusCode: 429, message: 'Too many exports. Try again later.', data: { code: 'audit/rate-limited' } })
  }

  const chunks: string[] = format === 'csv' ? [auditCsvHeader()] : []
  let before: number | undefined
  let total = 0
  for (;;) {
    const rows = await listWorkspaceAuditEvents(wsId, { ...query, beforeId: before, limit: BATCH })
    for (const row of rows) {
      const view = auditEventView(row)
      chunks.push(format === 'csv' ? auditCsvLine(view) : `${JSON.stringify(view)}\n`)
    }
    total += rows.length
    if (rows.length < BATCH) break
    if (total >= MAX_ROWS) {
      throw createError({ statusCode: 413, message: `More than ${MAX_ROWS} events — choose a shorter period.`, data: { code: 'audit/too-many-rows' } })
    }
    before = rows.at(-1)!.id
  }

  await appendAuditEvent({
    actorUserId: userId,
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
})
