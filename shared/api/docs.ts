// Request schemas of the document routes (server/api/docs/**). Shared with the
// client, which may validate a form with the same schema before sending.
import { z } from 'zod'

/** An ISO 8601 date-time with a zone (what the client sends: `toISOString()`). */
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/

/** PUT /api/docs/:docId/share-settings. A field left out keeps its value; an empty body changes nothing. */
export const updateShareSettingsBody = z.object({
  expiresAt: z.string().regex(ISO_DATE_TIME).refine(s => Number.isFinite(Date.parse(s))).nullable().optional(),
  noDownload: z.boolean().optional()
}).nullish()
