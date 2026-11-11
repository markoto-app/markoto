/** A positive safe integer from an environment value, or `fallback` when unset or invalid. */
export function positiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback
  const n = Number.parseInt(raw, 10)
  return Number.isSafeInteger(n) && n > 0 ? n : fallback
}
