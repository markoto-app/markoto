import { createDocument } from '../utils/createDocument'
import { ensureAnonCreatorKey, hashAnonCreatorKey } from '../utils/anonCreator'
import { enforceAnonGate } from '../utils/anonGate/gate'
import { ANON_DOC_CREATE_LIMITS } from '~~/shared/config/anonLimits'
import { isAudienceKind, type AudienceKind } from '~~/shared/audiences'
import { isTemplateId } from '~~/shared/templates'
import { INITIAL_CONTENT_MAX_LENGTH } from '~~/shared/config/docCreate'

// Document creation. Anonymous creation is allowed — falls back to
// `open-edit` access mode with no workspace — but gated (hosted shape,
// `NUXT_ANON_GATE_ENABLED`): the visitor must have accepted the Terms +
// age statement and must send a fresh ALTCHA proof-of-work solution
// (`altcha` + `acceptTerms` in the body; see server/utils/anonGate/).
// The accepted terms version + time are stored on the doc row.
//
// All validation + theme resolution lives in `createDocument()` so the
// AI tool handler (`handleCreateDocument` in aiToolAdapter.ts) shares
// the exact same behavior. This endpoint stays thin: parse the raw
// JSON body into typed fields, hand off.

interface RawBody {
  altcha?: unknown
  acceptTerms?: unknown
  workspaceId?: unknown
  title?: unknown
  description?: unknown
  audience?: unknown
  language?: unknown
  templateId?: unknown
  themePreset?: unknown
  themeId?: unknown
  content?: unknown
}

export default defineEventHandler(async (event) => {
  // `getValidatedUserSession` cross-checks the DB and clears stale cookies.
  const session = await getValidatedUserSession(event)
  const ownerId = session?.user?.id ?? null

  // Rate limit ANONYMOUS creation only, per client key (IPv4 or IPv6
  // /64): each doc is a Postgres row + Y.js state that lives until the
  // inactive-doc sweep, and anonymous docs are the abuse surface
  // (phishing / spam pages on our domain). On top of the bot check.
  // Logged-in users are accountable (owned rows, plan caps) and skip this.
  if (!ownerId) {
    const ip = getClientRateLimitKey(event)
    for (const limit of ANON_DOC_CREATE_LIMITS) {
      if (!(await checkRateLimit(limit.namespace, ip, limit.max, limit.windowMs))) {
        throw createError({
          statusCode: 429,
          message: 'Too many new documents from this network. Sign in, or try again later.',
          data: { code: 'docs/rate-limited', messageKey: 'anonGate.errors.rateLimited' }
        })
      }
    }
  }

  const body = await readBody<RawBody>(event).catch((): RawBody => ({}))

  // Endpoint-level type-shape validation (must reject 400 on wrong
  // types or unknown enum values — preserves the original endpoint
  // contract). The deeper field validation (length caps, mutex
  // checks) lives inside `createDocument`.
  const audience = parseEnumOrThrow(body.audience, isAudienceKind, 'Invalid audience')
  const templateId = parseEnumOrThrow(body.templateId, isTemplateId, 'Unknown templateId')
  if (body.title !== undefined && typeof body.title !== 'string') {
    throw createError({ statusCode: 400, message: 'Title must be a string' })
  }
  if (body.description !== undefined && typeof body.description !== 'string') {
    throw createError({ statusCode: 400, message: 'Description must be a string' })
  }
  if (body.language !== undefined && typeof body.language !== 'string') {
    throw createError({ statusCode: 400, message: 'Language must be a string' })
  }
  if (body.themePreset !== undefined && typeof body.themePreset !== 'string') {
    throw createError({ statusCode: 400, message: 'themePreset must be a string' })
  }
  if (body.themeId !== undefined && typeof body.themeId !== 'string') {
    throw createError({ statusCode: 400, message: 'themeId must be a string' })
  }
  // Optional starting Markdown (the marketing `::try-it` block): stored as
  // the doc's first Y.js update, like text typed into the editor. The
  // length is checked here too, so an oversized body never burns the
  // visitor's bot-check solution; `createDocument` re-checks it and the
  // mutex with templateId.
  if (body.content !== undefined && typeof body.content !== 'string') {
    throw createError({ statusCode: 400, message: 'content must be a string' })
  }
  if (typeof body.content === 'string' && body.content.length > INITIAL_CONTENT_MAX_LENGTH) {
    throw createError({ statusCode: 400, message: `Content too long (max ${INITIAL_CONTENT_MAX_LENGTH} characters)`, data: { code: 'docs/content-too-long' } })
  }

  // Anonymous gate AFTER the cheap shape checks (a malformed body never
  // burns the visitor's solution) and BEFORE anything is written.
  const acceptance = ownerId === null
    ? await enforceAnonGate(event, { altcha: body.altcha, acceptTerms: body.acceptTerms }, 'doc-create')
    : null

  // Anonymous creation: bind the doc to this browser's creator key
  // (httpOnly cookie, minted on first anonymous create) so only this
  // browser can delete it later. Only the hash is stored.
  const anonCreatorKeyHash = ownerId === null
    ? hashAnonCreatorKey(ensureAnonCreatorKey(event))
    : undefined

  const result = await createDocument({
    ownerId,
    anonCreatorKeyHash,
    anonTermsAcceptance: acceptance ?? undefined,
    workspaceId: typeof body.workspaceId === 'string' ? body.workspaceId : null,
    title: body.title as string | undefined,
    description: body.description as string | undefined,
    audience: audience as AudienceKind | undefined,
    language: body.language as string | undefined,
    templateId,
    themePreset: body.themePreset as string | undefined,
    themeId: body.themeId as string | undefined,
    content: typeof body.content === 'string' ? body.content : undefined
  })
  return { docId: result.docId }
})

/**
 * Reject `undefined` (omitted), accept matching enum value, throw 400
 * on anything else (wrong type or unknown value). Keeps the endpoint
 * strict on enums while letting omission fall through to the helper.
 */
function parseEnumOrThrow<T extends string>(
  raw: unknown,
  check: (v: unknown) => v is T,
  message: string
): T | undefined {
  if (raw === undefined) return undefined
  if (!check(raw)) {
    throw createError({ statusCode: 400, message })
  }
  return raw
}
