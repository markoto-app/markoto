import { and, desc, eq, gte, like, lt } from 'drizzle-orm'
import * as Sentry from '@sentry/nuxt'
import { auditLog, users } from '../db/schema'
import { useDatabase } from '../utils/platform/database'

// Audit-log repository. Append-only: there is no `updateAuditEvent` and
// no `deleteAuditEvent` on purpose — once written, a row is immutable.
// The only legitimate way for a row to disappear is the `set null` FK
// on actor_user_id (when a user account is purged) or a manual DBA
// action.
//
// See `schema.ts` for the data-model rationale and §4 in AGENTS.md for
// where audit fits in the security model.

export type AuditScope = 'doc' | 'workspace' | 'user' | 'billing' | 'system'

export interface AppendAuditEventArgs {
  actorUserId: number | null
  actorIp: string | null
  scope: AuditScope
  scopeId: string | null
  action: string
  before?: unknown
  after?: unknown
  metadata?: Record<string, unknown>
  /**
   * The workspace the event belongs to (WP15). Defaults to `scopeId` for
   * `workspace` and `billing` events (their scope id IS the workspace);
   * pass it for document events of a workspace document.
   */
  workspaceId?: string | null
}

export interface AuditEventRow {
  id: number
  ts: Date
  actorUserId: number | null
  actorIp: string | null
  scope: AuditScope
  scopeId: string | null
  action: string
  before: unknown
  after: unknown
  metadata: Record<string, unknown> | null
}

/**
 * Truncate an IP for GDPR pseudonymisation.
 *
 *   IPv4: drop the last octet  (192.168.1.42  → 192.168.1.0)
 *   IPv6: keep first 3 hextets (2001:db8:85a3:…  → 2001:db8:85a3::)
 *
 * Returns null for null / empty / unparseable input. Conservative on
 * malformed strings — if we can't reason about the format, drop the
 * whole field rather than store something half-truncated.
 */
export function truncateIp(ip: string | null): string | null {
  if (!ip) return null
  const trimmed = ip.trim()
  if (!trimmed) return null
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(trimmed)) return truncateIpv4(trimmed)
  if (trimmed.includes(':')) return truncateIpv6(trimmed)
  return null
}

/** IPv4 — drop the last octet. Returns null if any octet is out of range. */
function truncateIpv4(trimmed: string): string | null {
  const parts = trimmed.split('.')
  if (parts.some(p => Number(p) > 255)) return null
  return `${parts[0]}.${parts[1]}.${parts[2]}.0`
}

/**
 * IPv6 — keep the first 3 hextets; append `::` to mark the rest masked.
 * Accept both compressed (`::`) and full forms. Strip leading zeros per
 * RFC 5952 so the stored form is canonical. IPv4-mapped IPv6 (e.g.
 * `::ffff:192.0.2.1`) is treated as IPv6 — the hextet truncation drops
 * the embedded address.
 */
function truncateIpv6(trimmed: string): string | null {
  const parts = expandIpv6(trimmed)
  if (!parts || parts.length < 3) return null
  if (parts.some(p => !/^[0-9a-fA-F]{0,4}$/.test(p))) return null
  const head = parts.slice(0, 3).map(p => p.replace(/^0+(?=.)/, '').toLowerCase())
  return `${head.join(':')}::`
}

/**
 * Expand the `::` shortcut into explicit zero hextets so callers can
 * reliably take the first N. Returns null if the shortcut is over-wide
 * (more than 8 hextets after expansion).
 */
function expandIpv6(trimmed: string): string[] | null {
  if (!trimmed.includes('::')) return trimmed.split(':')
  const [left, right] = trimmed.split('::')
  const leftParts = left ? left.split(':') : []
  const rightParts = right ? right.split(':') : []
  const fillCount = 8 - leftParts.length - rightParts.length
  if (fillCount < 0) return null
  return [...leftParts, ...new Array<string>(fillCount).fill('0'), ...rightParts]
}

/**
 * Append an audit event. Swallows write failures: the user's primary
 * action has already committed by the time we get here, and a wedged
 * audit table must not flip a successful action into an error response.
 * Failures are reported to Sentry + logged so they're observable
 * without affecting the request path.
 */
export async function appendAuditEvent(args: AppendAuditEventArgs): Promise<void> {
  try {
    const db = useDatabase()
    await db.insert(auditLog).values({
      actorUserId: args.actorUserId,
      actorIp: truncateIp(args.actorIp),
      scope: args.scope,
      scopeId: args.scopeId,
      action: args.action,
      before: args.before === undefined ? null : args.before,
      after: args.after === undefined ? null : args.after,
      metadata: args.metadata ?? null,
      workspaceId: args.workspaceId !== undefined
        ? args.workspaceId
        : (args.scope === 'workspace' || args.scope === 'billing') ? args.scopeId : null
    })
  } catch (e) {
    console.error('[audit] append failed:', e instanceof Error ? e.message : e)
    Sentry.captureException(e, {
      tags: { component: 'audit', event: 'append_failed', auditAction: args.action }
    })
    // Deliberately do NOT rethrow.
  }
}

/**
 * List audit events for a (scope, scopeId) tuple. Tuple-keyed so a
 * caller asking for `('doc', 'A')` cannot leak rows from `('doc', 'B')`
 * — same isolation pattern as `getActivityById` / `/diff` / `/comment-context`.
 *
 * Pagination via `beforeId` (cursor — most-recent-first); pass the
 * smallest `id` from the previous page to fetch older rows.
 */
export async function getAuditEventsByScope(
  scope: AuditScope,
  scopeId: string,
  opts: { limit?: number, beforeId?: number } = {}
): Promise<AuditEventRow[]> {
  const db = useDatabase()
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500)
  const where = opts.beforeId === undefined
    ? and(eq(auditLog.scope, scope), eq(auditLog.scopeId, scopeId))
    : and(eq(auditLog.scope, scope), eq(auditLog.scopeId, scopeId), lt(auditLog.id, opts.beforeId))
  const rows = await db
    .select()
    .from(auditLog)
    .where(where)
    .orderBy(desc(auditLog.ts), desc(auditLog.id))
    .limit(limit)
  return rows as AuditEventRow[]
}

/**
 * List audit events triggered by a specific actor. Used for
 * "investigate compromised account" workflows — admin enters a user id,
 * sees every security-sensitive action that user has performed.
 */
export async function getAuditEventsByActor(
  actorUserId: number,
  opts: { limit?: number, beforeId?: number } = {}
): Promise<AuditEventRow[]> {
  const db = useDatabase()
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500)
  const where = opts.beforeId === undefined
    ? eq(auditLog.actorUserId, actorUserId)
    : and(eq(auditLog.actorUserId, actorUserId), lt(auditLog.id, opts.beforeId))
  const rows = await db
    .select()
    .from(auditLog)
    .where(where)
    .orderBy(desc(auditLog.ts), desc(auditLog.id))
    .limit(limit)
  return rows as AuditEventRow[]
}

// ── Workspace audit log (WP15) ──────────────────────────────────────

export interface WorkspaceAuditRow {
  id: number
  ts: Date
  actorUserId: number | null
  /** Null for system actions and deleted accounts. */
  actorName: string | null
  actorIp: string | null
  scope: AuditScope
  scopeId: string | null
  action: string
  before: unknown
  after: unknown
  metadata: Record<string, unknown> | null
}

export interface WorkspaceAuditQuery {
  /** Rows older than this id (cursor, newest first). */
  beforeId?: number
  limit?: number
  /** Action prefix, e.g. `sso.` or `workspace.member_`. */
  actionPrefix?: string
  from?: Date
  to?: Date
}

/** The workspace's audit events, newest first, with the actor's name. */
export async function listWorkspaceAuditEvents(workspaceId: string, q: WorkspaceAuditQuery = {}): Promise<WorkspaceAuditRow[]> {
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 1000)
  const conditions = [eq(auditLog.workspaceId, workspaceId)]
  if (q.beforeId !== undefined) conditions.push(lt(auditLog.id, q.beforeId))
  if (q.actionPrefix) conditions.push(like(auditLog.action, `${q.actionPrefix.replace(/[%_\\]/g, m => `\\${m}`)}%`))
  if (q.from) conditions.push(gte(auditLog.ts, q.from))
  if (q.to) conditions.push(lt(auditLog.ts, q.to))
  const rows = await useDatabase()
    .select({
      id: auditLog.id,
      ts: auditLog.ts,
      actorUserId: auditLog.actorUserId,
      actorName: users.name,
      actorIp: auditLog.actorIp,
      scope: auditLog.scope,
      scopeId: auditLog.scopeId,
      action: auditLog.action,
      before: auditLog.before,
      after: auditLog.after,
      metadata: auditLog.metadata
    })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.actorUserId))
    .where(and(...conditions))
    .orderBy(desc(auditLog.id))
    .limit(limit)
  return rows as WorkspaceAuditRow[]
}
