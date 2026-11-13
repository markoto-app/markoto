/**
 * Structural equality for JSON values, ignoring object key order.
 *
 * Postgres `jsonb` does not keep key order (it sorts keys by length,
 * then bytes), so a theme read back from the database is the same theme
 * but `JSON.stringify` of it differs from the in-code preset. Compare
 * themes with this, not `JSON.stringify`, or a stored theme never equals
 * the preset it was copied from.
 */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((v, i) => jsonEqual(v, b[i]))
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  const aKeys = Object.keys(a).filter(k => Reflect.get(a, k) !== undefined)
  const bKeys = Object.keys(b).filter(k => Reflect.get(b, k) !== undefined)
  if (aKeys.length !== bKeys.length) return false
  return aKeys.every(k => Object.hasOwn(b, k) && jsonEqual(Reflect.get(a, k), Reflect.get(b, k)))
}
