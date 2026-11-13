// Shape of the opaque ids (document, file, session, SSO connection) that
// appear in URLs and request bodies. Anything outside this shape is refused
// before it reaches a query or a storage key.

/** Regex source of one id; embed in larger patterns. */
export const ID_PATTERN = '[A-Za-z0-9_-]{1,64}'

/** A string that is exactly one id. */
export const ID_RE = new RegExp(`^${ID_PATTERN}$`)
