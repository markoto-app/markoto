// Request schemas of the platform, public and internal routes (server/api/_internal,
// internal, _test, published and the non-/api routes). The internal routes are
// called by other containers, the `_test` ones only under test mode.
import { z } from 'zod'
import { serialId } from './ids'

/** GET /api/_internal/legal/:slug. The slug allowlist stays in the handler (an unknown slug is a 404, not a 400). */
export const legalDocumentParams = z.object({ slug: z.string() })
/** A repeated or otherwise unusable `locale` falls back to English, like an unsupported one. */
export const legalDocumentQuery = z.object({ locale: z.string().optional().catch(undefined) })

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

/** POST /api/internal/activity: the schema lives with the activity contract the sync server shares. */
export { internalActivityBody } from '../contracts/activity'

/** POST /api/internal/comments-snapshot: shared with the sync server that sends it. */
export { commentsSnapshotBody } from '../contracts/syncInternal'

/** POST /api/_test/login. */
export const testLoginBody = z.object({
  userId: serialId,
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
