/**
 * One line per error in a `cause` chain, for operator CLIs: the first line
 * of each message plus the driver's error code (Postgres SQLSTATE, Node
 * system codes). Drizzle's "Failed query" wraps the real Postgres error in
 * `cause`, and its own message continues with the bound parameters (which
 * can be email addresses), so only the first line of a message is printed.
 */
export function describeError(error: unknown, maxDepth = 5): string[] {
  const lines: string[] = []
  let current: unknown = error
  for (let depth = 0; current !== undefined && current !== null && depth < maxDepth; depth++) {
    const prefix = depth === 0 ? '' : 'caused by: '
    if (!(current instanceof Error)) {
      lines.push(prefix + (String(current).split('\n')[0] ?? ''))
      break
    }
    const code = (current as { code?: unknown }).code
    const firstLine = current.message.split('\n')[0] ?? ''
    lines.push(prefix + firstLine + (typeof code === 'string' && code ? ` (code ${code})` : ''))
    current = current.cause
  }
  return lines
}
