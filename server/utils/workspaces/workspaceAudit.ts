// Workspace audit log: who may read it and the view / export shape. The
// query is parsed by `listAuditEventsQuery` (shared/api/legal.ts); the rows
// come from `audit_log.workspace_id`
// (`server/repos/audit.ts#listWorkspaceAuditEvents`).
//
// - Workspace ADMINS of a workspace whose plan includes `auditLog`
//   (Business on markoto.app; every workspace when self-hosted). Normal
//   role check: in a workspace that enforces single sign-on, that means
//   a current SSO sign-in too.
// - Truncated IPs (/24, /48) are shown; never secrets
//   (the audit writers store none).
// - Retention: the instance's audit retention (2 years by default,
//   `NUXT_AUDIT_LOG_RETENTION_DAYS`): shown, not configurable here.

import type { WorkspaceAuditRow } from '../../repos/audit'
import { resolveAuditLogRetentionDays } from '../privacy/legalRetentionSweep'

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
