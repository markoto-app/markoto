// Parsers for what the app receives from the renderer (types in `render.ts`,
// which the renderer shares as a pinned copy). The renderer is our own
// container, but its answer crosses a process boundary: a version skew
// during a deploy must surface as a clear error, not as a crash on a field
// that isn't there.
import { z } from 'zod'
import type { RenderManifest, RenderResponse, WebSnapshot } from './render'

const webSnapshotSchema = z.object({
  html: z.string(),
  css: z.string(),
  fontsImport: z.string(),
  hljsTheme: z.string(),
  hljsUrl: z.string().nullable(),
  language: z.string()
}) satisfies z.ZodType<WebSnapshot>

export const renderResponseSchema = z.object({
  pageCount: z.number().int().nonnegative(),
  pdfKey: z.string().optional(),
  pageKeys: z.array(z.string()),
  web: webSnapshotSchema.optional()
}) satisfies z.ZodType<RenderResponse>

export const renderManifestSchema = z.object({
  snapshotId: z.number(),
  pageCount: z.number().int().nonnegative(),
  format: z.enum(['pdf', 'png', 'both']),
  renderedAt: z.string(),
  pdfKey: z.string().nullable(),
  pageKeys: z.array(z.string())
}) satisfies z.ZodType<RenderManifest>

/** The `{ error }` body of a refused render. */
export const renderErrorSchema = z.object({ error: z.string().optional() })
