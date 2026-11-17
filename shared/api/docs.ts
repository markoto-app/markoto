// Request schemas of the document routes (server/api/docs/**). Shared with the
// client, which may validate a form with the same schema before sending.
import { z } from 'zod'
import { serialId } from './ids'
import { clickIdBody } from '../analytics/attribution'
import { AUDIENCE_KINDS } from '../audiences'
import { LANGUAGE_MAX_LENGTH } from '../languages'
import { isTemplateId, resolveTemplateId } from '../templates'
import { DOC_DESCRIPTION_MAX_LENGTH, DOC_TITLE_MAX_LENGTH } from '../config/docCreate'
import { DOC_PASSWORD_MAX_LENGTH } from '../config/docPassword'
import { isValidTheme } from '../utils/theme/themeValidation'
import type { DocTheme } from '../types/theme'

/** An ISO 8601 date-time with a zone (what the client sends: `toISOString()`). */
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/

/** PUT /api/docs/:docId/share-settings. A field left out keeps its value; an empty body changes nothing. */
export const updateShareSettingsBody = z.object({
  expiresAt: z.string().regex(ISO_DATE_TIME).refine(s => Number.isFinite(Date.parse(s))).nullable().optional(),
  noDownload: z.boolean().optional()
}).nullish()

const DOC_ACCESS_MODES = ['private', 'open-edit', 'open-view', 'password-protected'] as const

const audience = z.enum(AUDIENCE_KINDS)

/**
 * POST /api/docs. Only the types are checked here; lengths, the theme preset,
 * `content` vs `templateId` and the workspace role are checked by
 * `createDocument` (shared with the AI tool). `altcha` + `acceptTerms` are the
 * anonymous gate's fields. A missing body creates a blank document.
 */
export const createDocBody = z.object({
  altcha: z.unknown().optional(),
  acceptTerms: z.unknown().optional(),
  // Anything but a string means "no workspace", as it always did.
  workspaceId: z.string().nullish().catch(null),
  title: z.string().optional(),
  description: z.string().optional(),
  audience: audience.optional(),
  language: z.string().optional(),
  templateId: z.string().refine(isTemplateId).optional(),
  themePreset: z.string().optional(),
  themeId: z.string().optional(),
  // The length cap answers `docs/content-too-long` in the handler.
  content: z.string().optional(),
  // Google Ads click id of this visit (shared/analytics/attribution.ts).
  attribution: clickIdBody.optional()
}).nullish()

const WORD_COUNT_MAX = 10_000_000
const SIZE_BYTES_MAX = 100_000_000

/** A non-negative count, rounded; a value that is not a number is ignored (older clients sent other shapes). */
const optionalCount = (max: number) => z.preprocess(
  v => typeof v === 'number' ? v : undefined,
  z.number().min(0).max(max).transform(Math.round).optional()
)

/**
 * PUT /api/docs/:docId/meta. Every field is optional; a field left out keeps
 * its value. `theme: null` resets the theme. Changing `accessMode` needs
 * manage rights, everything else edit rights (checked in the handler).
 */
export const updateDocMetaBody = z.object({
  title: z.string().max(DOC_TITLE_MAX_LENGTH).transform(s => s.trim()).optional(),
  accessMode: z.enum(DOC_ACCESS_MODES).optional(),
  wordCount: optionalCount(WORD_COUNT_MAX),
  sizeBytes: optionalCount(SIZE_BYTES_MAX),
  theme: z.custom<DocTheme>(isValidTheme, { message: 'Invalid theme' }).nullable().optional(),
  description: z.string().max(DOC_DESCRIPTION_MAX_LENGTH).transform(s => s.trim()).optional(),
  audience: audience.optional(),
  language: z.string().trim().min(1).max(LANGUAGE_MAX_LENGTH).optional(),
  // A registered id or an alias of one, stored as the registered id.
  templateId: z.string().refine(isTemplateId).transform(id => resolveTemplateId(id) ?? id).optional()
})

/** POST /api/docs/:docId/password. `set` checks the minimum length itself (`password/too-short`); the maximum is a schema bound for every action. */
export const docPasswordBody = z.object({
  action: z.enum(['set', 'verify', 'remove']),
  password: z.string().max(DOC_PASSWORD_MAX_LENGTH).optional()
})

/** GET /api/docs/:docId/token. `refresh=1`: the editor's reconnect, not a new open. */
export const docTokenQuery = z.object({
  refresh: z.string().optional().catch(undefined)
})

/** GET /api/docs/:docId/pdf. `inline=1|true`: open in the tab; `response=json`: `{ url }` instead of a redirect. */
export const docPdfQuery = z.object({
  inline: z.string().optional().catch(undefined),
  response: z.string().optional().catch(undefined)
})

/** /api/docs/:docId/activity/:activityId/* */
export const activityParams = z.object({
  docId: z.string().min(1),
  activityId: serialId
})
