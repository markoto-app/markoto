/**
 * The value, or a thrown invariant error when it is null / undefined. For
 * values the code's own logic guarantees (a row `INSERT … RETURNING` just
 * produced, a regex group that always participates) where a `!` would hide a
 * broken guarantee as a crash further away. `what` names the value in the
 * error.
 */
export function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`Invariant: ${what} is missing`)
  return value
}
