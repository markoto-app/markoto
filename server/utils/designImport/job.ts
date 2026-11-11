import { z } from 'zod'
import { DocThemeSchema } from '~~/shared/types/theme'
import { DESIGN_IMPORT_ERROR_CODES, DESIGN_IMPORT_PHASES } from '~~/shared/config/designImport'
import { useValkey } from '../valkey'

// State of one "Create a design from a document" run, polled by the
// dialog (`GET /api/themes/from-document/jobs/:jobId`). Valkey only: the
// run is short-lived and its result is either saved by the user as a
// theme (`/api/themes`) or thrown away. Bound to the user who started it;
// anyone else gets a 404, the same as an unknown id.

const DESIGN_IMPORT_JOB_TTL_SECONDS = 30 * 60

export const DesignImportJobState = z.object({
  userId: z.number().int(),
  phase: z.enum(DESIGN_IMPORT_PHASES),
  round: z.number().int().min(0),
  maxRounds: z.number().int().min(1),
  format: z.enum(['pdf', 'docx']),
  result: z.object({
    theme: DocThemeSchema,
    name: z.string(),
    description: z.string(),
    /** Our render of the final design (base64 PNG pages). */
    preview: z.array(z.string()),
    /** The original's first pages (PDF only, base64 PNG). */
    original: z.array(z.string()),
    fonts: z.array(z.object({ from: z.string(), to: z.string(), exact: z.boolean() })),
    /** Short facts for a Word file, shown instead of page pictures. */
    swatches: z.array(z.string()),
    rounds: z.number().int()
  }).optional(),
  error: z.object({ code: z.enum(DESIGN_IMPORT_ERROR_CODES), message: z.string() }).optional()
})
export type DesignImportJobState = z.infer<typeof DesignImportJobState>
export type DesignImportResult = NonNullable<DesignImportJobState['result']>

function jobKey(jobId: string): string {
  return `design-import:job:${jobId}`
}

export async function writeJob(jobId: string, state: DesignImportJobState): Promise<void> {
  await useValkey().set(jobKey(jobId), JSON.stringify(state), 'EX', DESIGN_IMPORT_JOB_TTL_SECONDS)
}

/** The job if it exists AND belongs to `userId`, else null. */
export async function readJob(jobId: string, userId: number): Promise<DesignImportJobState | null> {
  const raw = await useValkey().get(jobKey(jobId))
  if (!raw) return null
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return null
  }
  const parsed = DesignImportJobState.safeParse(json)
  if (!parsed.success || parsed.data.userId !== userId) return null
  return parsed.data
}
