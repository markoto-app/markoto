// Keyset cursor of the paginated document lists: the last row's sort key
// (as text, so timestamps keep their microseconds) and its document id,
// base64url-encoded JSON. Opaque to the client.

export function encodeDocCursor(sortKey: string, docId: string): string {
  return Buffer.from(JSON.stringify([sortKey, docId]), 'utf8').toString('base64url')
}

/** The decoded position, or null for anything that is not a cursor this server made. */
export function decodeDocCursor(raw: string | undefined): { key: string, docId: string } | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
    if (!Array.isArray(parsed) || parsed.length !== 2) return null
    const [key, docId] = parsed as unknown[]
    if (typeof key !== 'string' || typeof docId !== 'string' || key.length > 200 || !/^[A-Za-z0-9_-]{1,64}$/.test(docId)) return null
    return { key, docId }
  } catch {
    return null
  }
}
