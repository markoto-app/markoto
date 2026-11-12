/**
 * Whether `value` has the plain shape of an email address: one `@`, a
 * non-empty local part, a domain with a dot that has characters on both
 * sides, no whitespace, and none of `extraForbidden`. The same language as
 * `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` (plus the forbidden characters), checked
 * without a regex: that pattern backtracks quadratically on a long domain
 * of dots, and its inputs (IdP assertions, SCIM bodies) are third-party.
 */
export function isPlainEmail(value: string, extraForbidden = ''): boolean {
  const at = value.indexOf('@')
  if (at < 1 || at !== value.lastIndexOf('@')) return false
  for (const ch of value) {
    if (/\s/.test(ch) || extraForbidden.includes(ch)) return false
  }
  const domain = value.slice(at + 1)
  const dot = domain.indexOf('.', 1)
  return dot > 0 && dot < domain.length - 1
}
