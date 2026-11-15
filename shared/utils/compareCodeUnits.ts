// The order `Array.prototype.sort()` uses without a comparator: by UTF-16
// code units, independent of the runtime's locale. Ids, routes, paths and
// ISO dates are sorted this way so cache keys and generated files stay
// byte-identical on every machine; `localeCompare` would make the order
// depend on ICU data and the process locale.

/** Comparator for `sort`: negative, zero or positive by UTF-16 code units. */
export function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}
