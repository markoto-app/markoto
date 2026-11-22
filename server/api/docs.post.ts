import { createDocument } from '../utils/documents/createDocument'
import { ensureAnonCreatorKey, hashAnonCreatorKey } from '../utils/auth/anonCreator'
import { enforceAnonGate } from '../utils/anonGate/gate'
import { ANON_DOC_CREATE_LIMITS } from '~~/shared/config/anonLimits'
import { INITIAL_CONTENT_MAX_LENGTH } from '~~/shared/config/docCreate'
import { createDocBody } from '~~/shared/api/docs'
import { requestLocale } from '../utils/platform/requestLocale'
import { captureDocumentConversion } from '../utils/analytics/adConversions'

// Document creation. Anonymous creation is allowed (falls back to `open-edit`
// access mode, no workspace) but gated on the hosted shape
// (`NUXT_ANON_GATE_ENABLED`): the visitor must have accepted the Terms + age
// statement and send a fresh ALTCHA solution (`altcha` + `acceptTerms` in the
// body; server/utils/anonGate/). The accepted terms version + time are stored
// on the doc row.
//
// The schema checks the types; validation of the values and theme resolution
// live in `createDocument()`, shared with the AI tool handler
// (`handleCreateDocument`).

export default defineApiHandler({
  access: allow.public('Anonymous document creation: per-client rate limits and the anonymous gate (terms + ALTCHA) apply to callers without a session', { session: 'optional' }),
  body: createDocBody,
  handler: async ({ event, self, body }) => {
    const ownerId = self?.userId ?? null

    // Rate limit ANONYMOUS creation only, per client key (IPv4 or IPv6 /64):
    // each doc is a Postgres row + Y.js state living until the inactive-doc
    // sweep, and anonymous docs are the abuse surface (phishing / spam pages).
    // Logged-in users are accountable (owned rows, plan caps) and skip this.
    if (!ownerId) {
      const ip = getClientRateLimitKey(event)
      for (const limit of ANON_DOC_CREATE_LIMITS) {
        if (!(await checkRateLimit(limit.namespace, ip, limit.max, limit.windowMs))) {
          throw apiError('docs/rate-limited')
        }
      }
    }

    // Optional starting Markdown (the marketing `::try-it` block), stored as the
    // doc's first Y.js update. The length is checked here too so an oversized
    // body never burns the bot-check solution; `createDocument` re-checks it and
    // the mutex with templateId.
    if (body?.content !== undefined && body.content.length > INITIAL_CONTENT_MAX_LENGTH) {
      throw apiError('docs/content-too-long', { max: INITIAL_CONTENT_MAX_LENGTH })
    }

    // Anonymous gate AFTER the cheap shape checks (a malformed body never burns
    // the solution) and BEFORE anything is written.
    const acceptance = ownerId === null
      ? await enforceAnonGate(event, { altcha: body?.altcha, acceptTerms: body?.acceptTerms }, 'doc-create')
      : null

    // Anonymous creation: bind the doc to this browser's creator key
    // (httpOnly cookie, minted on first anonymous create) so only this
    // browser can delete it later. Only the hash is stored.
    const anonCreatorKeyHash = ownerId === null
      ? hashAnonCreatorKey(ensureAnonCreatorKey(event))
      : undefined

    const result = await createDocument({
      owner: self,
      anonCreatorKeyHash,
      anonTermsAcceptance: acceptance ?? undefined,
      workspaceId: body?.workspaceId ?? null,
      folderId: body?.folderId ?? null,
      title: body?.title,
      description: body?.description,
      audience: body?.audience,
      // No language chosen: the creator's UI language (new text follows it).
      language: body?.language ?? requestLocale(event) ?? undefined,
      templateId: body?.templateId,
      themePreset: body?.themePreset,
      themeId: body?.themeId,
      content: body?.content
    })
    // Google Ads conversion (off unless configured; never fails the request).
    await captureDocumentConversion(event, body?.attribution, self)
    return { docId: result.docId }
  }
})
