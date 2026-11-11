// Request schemas of the platform, public and internal routes (server/api/_internal,
// internal, _test, published and the non-/api routes). The internal routes are
// called by other containers, the `_test` ones only under test mode.
import { z } from 'zod'

/** GET /api/_internal/legal/:slug. The slug allowlist stays in the handler (an unknown slug is a 404, not a 400). */
export const legalDocumentParams = z.object({ slug: z.string() })
export const legalDocumentQuery = z.object({ locale: z.string().optional() })

/** GET /api/_internal/render-bootstrap?docId=&t=: the render token itself is verified by `allow.internal('render-token')`. */
export const renderBootstrapQuery = z.object({
  docId: z.string().min(1),
  t: z.string().min(1)
})

/** GET /api/published/:pageId/:kind/:file. The shapes are checked in the handler: a malformed one is a 404, like an unknown page. */
export const publishedFileParams = z.object({ pageId: z.string(), kind: z.string(), file: z.string() })

/** GET /p/:slug. */
export const publishedPageParams = z.object({ slug: z.string() })

/** GET /instance-brand/:file. */
export const instanceBrandParams = z.object({ file: z.string() })

/**
 * POST /api/internal/activity (sync-server → app). Optional fields of the
 * wrong type are ignored, as the sender is another container of the stack and
 * one bad field must not drop the whole row. `action` is checked against
 * ACTIVITY_ACTIONS in the handler (the list lives in server/repos).
 */
export const internalActivityBody = z.object({
  docId: z.string().min(1),
  action: z.string().min(1),
  userId: z.number().nullish().catch(null),
  userName: z.string().nullish().catch(null),
  actorPrincipal: z.string().nullish().catch(null),
  actorAvatarSeed: z.string().nullish().catch(null),
  wordCount: z.number().nullish(),
  linesAdded: z.number().nullish(),
  linesRemoved: z.number().nullish(),
  metadata: z.custom<object>(v => typeof v === 'object').nullish(),
  yjsDocIdBefore: z.number().nullish().catch(null),
  yjsDocIdAfter: z.number().nullish().catch(null)
})

/** POST /api/internal/comments-snapshot. The entries are shaped one by one in the handler, so a corrupt entry only drops itself. */
export const commentsSnapshotBody = z.object({
  docId: z.string().min(1),
  entries: z.array(z.unknown()),
  yjsDocIdBefore: z.number().nullish().catch(null),
  yjsDocIdAfter: z.number().nullish().catch(null)
})

/** POST /api/_test/login. */
export const testLoginBody = z.object({
  userId: z.coerce.number().int().positive(),
  name: z.string().optional().catch(undefined),
  loggedInAt: z.number().optional().catch(undefined)
})

/** POST /api/_test/exec-ai-tool. */
export const testExecAiToolBody = z.object({
  docId: z.string().min(1),
  name: z.string().min(1),
  args: z.unknown().optional()
})

/** POST /api/_test/exhaust-litellm-budget and /api/_test/reset-litellm-spend. */
export const testUserBody = z.object({ userId: z.number().int().positive() })
