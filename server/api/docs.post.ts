import { createDocument } from '../utils/createDocument'
import { ensureAnonCreatorKey, hashAnonCreatorKey } from '../utils/anonCreator'
import { isAudienceKind, type AudienceKind } from '~~/shared/audiences'
import { isTemplateId } from '~~/shared/templates'

// Document creation. Anonymous creation is allowed — falls back to
// `open-edit` access mode with no workspace.
//
// All validation + theme resolution lives in `createDocument()` so the
// AI tool handler (`handleCreateDocument` in aiToolAdapter.ts) shares
// the exact same behavior. This endpoint stays thin: parse the raw
// JSON body into typed fields, hand off.

interface RawBody {
  workspaceId?: unknown
  title?: unknown
  description?: unknown
  audience?: unknown
  language?: unknown
  templateId?: unknown
  themePreset?: unknown
  themeId?: unknown
}

export default defineEventHandler(async (event) => {
  // `getValidatedUserSession` cross-checks the DB and clears stale cookies.
  const session = await getValidatedUserSession(event)
  const ownerId = session?.user?.id ?? null

  // Rate limit ANONYMOUS creation only: each doc is a Postgres row +
  // Y.js state that lives until the inactive-doc sweep, so an
  // unauthenticated loop could fill the documents table with junk.
  // 30/min per IP is far above human "new doc" cadence; logged-in
  // users are accountable (owned rows, plan caps) and skip this.
  if (!ownerId) {
    const ip = getClientRateLimitKey(event)
    if (!(await checkRateLimit('anon-doc-create', ip, 30, 60_000))) {
      throw createError({
        statusCode: 429,
        message: 'Too many new documents. Try again in a minute.',
        data: { code: 'docs/rate-limited', messageKey: 'error.rateLimited' }
      })
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

  // Anonymous creation: bind the doc to this browser's creator key
  // (httpOnly cookie, minted on first anonymous create) so only this
  // browser can delete it later. Only the hash is stored.
  const anonCreatorKeyHash = ownerId === null
    ? hashAnonCreatorKey(ensureAnonCreatorKey(event))
    : undefined

  const result = await createDocument({
    ownerId,
    anonCreatorKeyHash,
    workspaceId: typeof body.workspaceId === 'string' ? body.workspaceId : null,
    title: body.title as string | undefined,
    description: body.description as string | undefined,
    audience: audience as AudienceKind | undefined,
    language: body.language as string | undefined,
    templateId,
    themePreset: body.themePreset as string | undefined,
    themeId: body.themeId as string | undefined
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
