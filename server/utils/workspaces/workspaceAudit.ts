// Workspace audit log (WP15): who may read it, query parsing, and the
// view / export shape. The rows come from `audit_log.workspace_id`
// (`server/repos/audit.ts#listWorkspaceAuditEvents`).
//
// - Workspace ADMINS of a workspace whose plan includes `auditLog`
//   (Business on markoto.app; every workspace when self-hosted). Normal
//   role check — in a workspace that enforces single sign-on, that means
//   a current SSO sign-in too.
// - Truncated IPs (/24, /48) are shown (decision WP15); never secrets
//   (the audit writers store none).
// - Retention: the instance's audit retention (2 years by default,
//   `NUXT_AUDIT_LOG_RETENTION_DAYS`) — shown, not configurable here.

import type { H3Event } from 'h3'
import type { WorkspaceAuditQuery, WorkspaceAuditRow } from '../../repos/audit'
import { assertPlanFeature, resolveWorkspacePlan } from '../billing/entitlements'
import { resolveAuditLogRetentionDays } from '../privacy/legalRetentionSweep'

export async function requireAuditLogAccess(event: H3Event): Promise<{ userId: number, wsId: string }> {
  const session = await requireValidatedUserSession(event)
  const wsId = requireWsId(event)
  const role = await getWorkspaceRole(session.user.id, wsId)
  if (role === null) throw createError({ statusCode: 404, message: 'Workspace not found' })
  if (role !== 'admin') throw createError({ statusCode: 403, message: 'Only workspace admins can see the audit log.', data: { code: 'audit/admin-required' } })
  assertPlanFeature(await resolveWorkspacePlan(wsId), 'auditLog', 'The audit log is part of the Business plan.')
  return { userId: session.user.id, wsId }
}

function dateParam(raw: unknown, field: string): Date | undefined {
  if (raw === undefined || raw === '') return undefined
  const d = typeof raw === 'string' ? new Date(raw) : null
  if (!d || Number.isNaN(d.getTime())) throw createError({ statusCode: 400, message: `Invalid ${field} date.`, data: { code: 'audit/invalid-query', field } })
  return d
}

export function parseAuditQuery(q: Record<string, unknown>): WorkspaceAuditQuery {
  const query: WorkspaceAuditQuery = {}
  if (q.before !== undefined) {
    const before = Number(q.before)
    if (!Number.isInteger(before) || before <= 0) throw createError({ statusCode: 400, message: 'Invalid cursor.', data: { code: 'audit/invalid-query', field: 'before' } })
    query.beforeId = before
  }
  if (q.action !== undefined && q.action !== '') {
    if (typeof q.action !== 'string' || !/^[a-z_.]{1,64}$/.test(q.action)) throw createError({ statusCode: 400, message: 'Invalid action filter.', data: { code: 'audit/invalid-query', field: 'action' } })
    query.actionPrefix = q.action
  }
  query.from = dateParam(q.from, 'from')
  query.to = dateParam(q.to, 'to')
  return query
}

export interface AuditEventView {
  id: number
  at: string
  actor: { id: number | null, name: string | null }
  ip: string | null
  action: string
  target: { type: string, id: string | null }
  before: unknown
  after: unknown
  details: Record<string, unknown> | null
}

export function auditEventView(r: WorkspaceAuditRow): AuditEventView {
  return {
    id: r.id,
    at: r.ts.toISOString(),
    actor: { id: r.actorUserId, name: r.actorName },
    ip: r.actorIp,
    action: r.action,
    target: { type: r.scope, id: r.scopeId },
    before: r.before ?? null,
    after: r.after ?? null,
    details: r.metadata
  }
}

export function auditRetentionDays(): number {
  return resolveAuditLogRetentionDays()
}

const CSV_COLUMNS = ['id', 'time', 'actor_id', 'actor_name', 'ip', 'action', 'target_type', 'target_id', 'before', 'after', 'details'] as const

/** RFC 4180 field; formula-looking values are prefixed so spreadsheets don't execute them. */
export function csvField(value: unknown): string {
  let s = value === null || value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value)
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function auditCsvHeader(): string {
  return `${CSV_COLUMNS.join(',')}\r\n`
}

export function auditCsvLine(v: AuditEventView): string {
  return [v.id, v.at, v.actor.id, v.actor.name, v.ip, v.action, v.target.type, v.target.id, v.before, v.after, v.details].map(csvField).join(',') + '\r\n'
}
