// Request schemas of the brand kit, workspace template and saved-theme routes
// (server/api/workspaces/[wsId]/{brand,templates}/**, server/api/themes/**).
import { z } from 'zod'
import { BRAND_ASSET_FILE_RE, WORKSPACE_TEMPLATE_DESCRIPTION_MAX, WORKSPACE_TEMPLATE_NAME_MAX } from '../config/brandKit'
import { DOC_TITLE_MAX_LENGTH } from '../config/docCreate'
import { DocThemeSchema } from '../types/theme'

/** `:file` of a brand-kit file route: `<assetId>.<ext>`. */
export const brandFileParams = z.object({ file: z.string().regex(BRAND_ASSET_FILE_RE) })

export const brandAssetParams = z.object({ assetId: z.string().min(1) })

export const templateParams = z.object({ templateId: z.string().min(1) })

/** PUT /api/workspaces/:wsId/brand/lock */
export const setBrandLockBody = z.object({ locked: z.boolean() })

/** POST /api/workspaces/:wsId/brand/design-from-doc */
export const designFromDocBody = z.object({ docId: z.string().min(1) })

const templateName = z.string()
  .transform(s => s.replace(/\s+/g, ' ').trim())
  .pipe(z.string().min(1).max(WORKSPACE_TEMPLATE_NAME_MAX))

/** `null` clears the description (stored as ''); a missing field is left alone. */
const templateDescription = z.string().trim().max(WORKSPACE_TEMPLATE_DESCRIPTION_MAX)
  .nullable().optional()
  .transform(v => (v === null ? '' : v))

/** POST /api/workspaces/:wsId/templates */
export const createTemplateBody = z.object({
  docId: z.string().min(1),
  name: templateName,
  description: templateDescription
})

/** PATCH /api/workspaces/:wsId/templates/:templateId. A field left out keeps its value. */
export const updateTemplateBody = z.object({
  name: templateName.optional(),
  description: templateDescription
}).nullish()

/** POST /api/workspaces/:wsId/templates/:templateId/documents */
export const createDocFromTemplateBody = z.object({
  title: z.string().trim().max(DOC_TITLE_MAX_LENGTH).optional()
}).nullish()

export const themeParams = z.object({ themeId: z.string().min(1) })

// `name` / `description` stay unchecked here: their limits answer with the
// distinct `theme/name-*` / `theme/description-*` codes of
// server/utils/rendering/savedThemeFields.ts.

/** POST /api/themes */
export const createSavedThemeBody = z.object({
  name: z.unknown().optional(),
  description: z.unknown().optional(),
  theme: DocThemeSchema
})

/** PATCH /api/themes/:themeId: any subset. */
export const updateSavedThemeBody = z.object({
  name: z.unknown().optional(),
  description: z.unknown().optional(),
  theme: DocThemeSchema.optional()
}).nullish()

/** POST /api/themes/from-document/upload-request */
export const designImportUploadRequestBody = z.object({
  filename: z.string().trim().min(1).max(255),
  size: z.number().int().positive()
})

/** POST /api/themes/from-document/start */
export const designImportStartBody = z.object({
  uploadId: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/)
})

/** GET /api/themes/from-document/jobs/:jobId (the id's shape is checked in the handler: a malformed id is a 404 like an unknown one). */
export const designImportJobParams = z.object({ jobId: z.string() })
