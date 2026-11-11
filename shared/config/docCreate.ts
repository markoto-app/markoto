// Limits for `POST /api/docs` that the client checks too.

/** Longest document title (UTF-16 code units): HTTP create/update, the sync server's `ymeta` writes, imports, the AI's context block. */
export const DOC_TITLE_MAX_LENGTH = 255
/** Longest document description, same enforcement points as the title. */
export const DOC_DESCRIPTION_MAX_LENGTH = 500

/**
 * Longest Markdown body a new document may be created with (`content`,
 * UTF-16 code units). The `::try-it` block on the marketing pages sends
 * what the visitor typed; anything longer is refused with 400 rather than
 * cut. Far below the sync server's 16 MiB document cap.
 */
export const INITIAL_CONTENT_MAX_LENGTH = 200_000
