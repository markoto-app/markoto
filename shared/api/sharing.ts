// Request schemas of the sharing and publishing routes of a document
// (server/api/docs/[docId]/{shares,publish,duplicate,workspace}). The
// share-link settings schema stays in ./docs.ts. Shared with the client.
import { z } from 'zod'

/** PUT /api/docs/:docId/shares: share with a guest of the document's workspace, or change their access. */
export const upsertDocShareBody = z.object({
  // Coerced: clients have sent the id as a string.
  userId: z.coerce.number().int().positive(),
  access: z.enum(['view', 'edit'])
})

/** DELETE /api/docs/:docId/shares/:userId */
export const deleteDocShareParams = z.object({
  docId: z.string().min(1),
  userId: z.coerce.number().int().positive()
})

/**
 * POST + PATCH /api/docs/:docId/publish. An empty or null slug means "keep
 * (or generate) the address"; its format is checked by the handler, which
 * answers `publish/slug-invalid` with the format rule.
 */
export const publishDocBody = z.object({
  slug: z.string().nullish(),
  indexable: z.boolean().optional()
}).nullish()

/**
 * POST /api/docs/:docId/duplicate. `workspaceId` left out: the source's
 * workspace; null: a personal copy; a string: that workspace.
 */
export const duplicateDocBody = z.object({
  // A title that isn't a non-blank string falls back to "Copy of …" (the handler decides).
  title: z.string().optional().catch(undefined),
  workspaceId: z.string().min(1).nullable().optional()
}).nullish()

/** PATCH /api/docs/:docId/workspace: move into a workspace, or out of it (null). */
export const moveDocWorkspaceBody = z.object({
  workspaceId: z.string().min(1).nullable()
})
