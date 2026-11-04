// Limits for `POST /api/docs` that the client checks too.

/**
 * Longest Markdown body a new document may be created with (`content`,
 * UTF-16 code units). The `::try-it` block on the marketing pages sends
 * what the visitor typed; anything longer is refused with 400 rather than
 * cut. Far below the sync server's 16 MiB document cap.
 */
export const INITIAL_CONTENT_MAX_LENGTH = 200_000
