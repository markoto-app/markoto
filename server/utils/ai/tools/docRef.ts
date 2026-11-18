// A document reference as a model or MCP client writes it: a bare id or a
// markoto URL. Shared by the cross-document and folder tools.

/**
 * Strip a markoto URL down to a bare doc id. Accepts:
 *   - `xyz123abc`
 *   - `/d/xyz123abc`
 *   - `https://markoto.app/d/xyz123abc`
 *   - `markoto.app/d/xyz123abc?slide=2`
 *   - any host (so users on `localhost:3000` or staging URLs work)
 *
 * Returns null when no recognisable id can be extracted. The id rule
 * `[A-Za-z0-9_-]+` matches nanoid output and survives any future id
 * shape change as long as the alphabet stays URL-safe.
 */
export function parseDocIdFromInput(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  // Try URL-shape match first. Doesn't matter whether the input has a
  // scheme: `/d/<id>` is the load-bearing piece.
  const urlMatch = /\/d\/([A-Za-z0-9_-]+)(?:[/?#]|$)/.exec(trimmed)
  if (urlMatch) return urlMatch[1] ?? null
  // Otherwise treat as a bare id only if the WHOLE string matches the
  // id alphabet (not "https://example.com" with no `/d/` segment).
  if (/^[A-Za-z0-9_-]+$/.test(trimmed)) return trimmed
  return null
}
