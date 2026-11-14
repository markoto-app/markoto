// What an audit event changed, for the one-line summary in the audit log
// ("Team → Business"): the fields whose plain value differs between the
// event's `before` and `after`.

export type AuditScalar = string | number | boolean | null

export interface AuditChange {
  key: string
  from: AuditScalar
  to: AuditScalar
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isScalar(value: unknown): value is AuditScalar {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

/**
 * The changed fields, in the order `after` lists them. Empty when the event
 * has no before / after pair. Ids are left out: "12 → 15" tells a reader
 * nothing, the details view has them.
 */
export function auditChanges(before: unknown, after: unknown): AuditChange[] {
  if (!isRecord(before) || !isRecord(after)) return []
  const changes: AuditChange[] = []
  for (const key of Object.keys(after)) {
    if (/id$/i.test(key)) continue
    const from = before[key] ?? null
    const to = after[key] ?? null
    if (!isScalar(from) || !isScalar(to) || from === to) continue
    changes.push({ key, from, to })
  }
  return changes
}
