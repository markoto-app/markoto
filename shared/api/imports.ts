// Request schemas of the bulk import routes (server/api/imports/**). Shared
// with the import dialog.
import { z } from 'zod'
import { ID_RE } from '../config/identifiers'

const objectId = z.string().regex(ID_RE)

/** Files one upload manifest may list (counted and skipped together). */
export const IMPORT_MANIFEST_MAX_FILES = 20_000

const target = {
  /** null = the caller's personal documents. */
  workspaceId: objectId.nullable(),
  /** null = the root of that scope. */
  folderId: objectId.nullable()
}

/** POST /api/imports: start an upload (the manifest) or a GitHub import. */
export const createImportBody = z.discriminatedUnion('source', [
  z.object({
    source: z.literal('upload'),
    ...target,
    files: z.array(z.object({
      path: z.string().min(1).max(1024),
      size: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
    })).min(1).max(IMPORT_MANIFEST_MAX_FILES)
  }),
  z.object({
    source: z.literal('github'),
    ...target,
    url: z.string().trim().min(1).max(2000)
  })
])

export const importJobParams = z.object({ jobId: objectId })

/** GET /api/imports: the caller's recent imports, optionally only those into one scope. */
export const listImportsQuery = z.object({
  workspaceId: z.union([objectId, z.literal('personal')]).optional()
})
