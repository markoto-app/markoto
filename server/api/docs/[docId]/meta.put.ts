import { getDoc, updateDocMeta, type MetaUpdate } from '../../../repos/documents'
import { appendAuditEvent } from '../../../repos/audit'
import { isAudienceKind } from '~~/shared/audiences'
import { LANGUAGE_MAX_LENGTH } from '~~/shared/languages'

const DESCRIPTION_MAX_LENGTH = 500
const TITLE_MAX_LENGTH = 255
const WORD_COUNT_MAX = 10_000_000
const SIZE_BYTES_MAX = 100_000_000
const ACCESS_MODES = new Set(['private', 'open-edit', 'open-view', 'password-protected'])

export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const docId = requireDocId(event)
  const body = await readBody(event)

  // Meta changes split by kind: accessMode is a sharing/ownership change
  // (owner + workspace admin only), everything else is an edit (owner +
  // admin + editor). Viewers cannot change anything.
  const authz = await getDocAuthz(session.user.id, docId)
  if (!authz.exists) {
    throw createError({ statusCode: 404, message: 'Document not found' })
  }
  if (!authz.canEdit) {
    throw createError({ statusCode: 403, message: 'Not authorized to edit this document' })
  }
  if (body.accessMode !== undefined && !authz.canManage) {
    throw createError({ statusCode: 403, message: 'Only owners and admins can change access mode' })
  }

  const updates = buildMetaUpdates(body)

  // Snapshot the prior access mode BEFORE the write so we can record
  // the before/after for the audit row. Only fetched when accessMode
  // is changing — title / description / theme / etc. are user-facing
  // edits captured by the activity log, not security events.
  let beforeAccessMode: string | null = null
  if (updates.accessMode !== undefined) {
    const snap = await getDoc(docId)
    beforeAccessMode = snap?.accessMode ?? null
  }

  await updateDocMeta(docId, updates)

  if (updates.accessMode !== undefined && beforeAccessMode !== updates.accessMode) {
    await appendAuditEvent({
      actorUserId: session.user.id,
      actorIp: extractIp(event),
      scope: 'doc',
      scopeId: docId,
      action: 'doc.access_mode_changed',
      before: { accessMode: beforeAccessMode },
      after: { accessMode: updates.accessMode }
    })
  }

  return { success: true }
})

function buildMetaUpdates(body: Record<string, unknown>): MetaUpdate {
  const updates: MetaUpdate = {}
  const title = parseTitle(body.title)
  if (title !== null) updates.title = title
  const accessMode = parseAccessMode(body.accessMode)
  if (accessMode !== null) updates.accessMode = accessMode
  const wordCount = parseBoundedInt(body.wordCount, WORD_COUNT_MAX, 'wordCount')
  if (wordCount !== null) updates.wordCount = wordCount
  const sizeBytes = parseBoundedInt(body.sizeBytes, SIZE_BYTES_MAX, 'sizeBytes')
  if (sizeBytes !== null) updates.sizeBytes = sizeBytes
  const theme = parseTheme(body.theme)
  if (theme !== undefined) updates.theme = theme
  const description = parseDescription(body.description)
  if (description !== null) updates.description = description
  const audience = parseAudience(body.audience)
  if (audience !== null) updates.audience = audience
  const language = parseLanguage(body.language)
  if (language !== null) updates.language = language
  return updates
}

function parseTitle(raw: unknown): string | null {
  if (raw === undefined) return null
  if (typeof raw !== 'string') throw createError({ statusCode: 400, message: 'Title must be a string' })
  if (raw.length > TITLE_MAX_LENGTH) throw createError({ statusCode: 400, message: `Title too long (max ${TITLE_MAX_LENGTH})` })
  return raw.trim()
}

function parseAccessMode(raw: unknown): MetaUpdate['accessMode'] | null {
  if (raw === undefined) return null
  if (typeof raw !== 'string' || !ACCESS_MODES.has(raw)) {
    throw createError({ statusCode: 400, message: 'Invalid access mode' })
  }
  return raw as MetaUpdate['accessMode']
}

/**
 * Parse a bounded non-negative integer. Returns null when the field is
 * absent OR not a number (the original behaviour: only assigned when
 * `typeof === 'number'`). Out-of-range / non-finite values throw 400.
 */
function parseBoundedInt(raw: unknown, max: number, fieldName: string): number | null {
  if (typeof raw !== 'number') return null
  if (raw < 0 || raw > max || !Number.isFinite(raw)) {
    throw createError({ statusCode: 400, message: `Invalid ${fieldName}` })
  }
  return Math.round(raw)
}

/**
 * Theme is special: returning `undefined` means "field absent",
 * `null` means "reset to defaultTheme" — both are distinct from a
 * structured DocTheme.
 */
function parseTheme(raw: unknown): MetaUpdate['theme'] | undefined {
  if (raw === undefined) return undefined
  if (raw !== null && !isValidTheme(raw)) {
    throw createError({ statusCode: 400, message: 'Invalid theme payload' })
  }
  return raw as MetaUpdate['theme']
}

function parseDescription(raw: unknown): string | null {
  if (raw === undefined) return null
  if (typeof raw !== 'string') {
    throw createError({ statusCode: 400, message: 'Description must be a string' })
  }
  if (raw.length > DESCRIPTION_MAX_LENGTH) {
    throw createError({ statusCode: 400, message: `Description too long (max ${DESCRIPTION_MAX_LENGTH})` })
  }
  return raw.trim()
}

function parseAudience(raw: unknown): MetaUpdate['audience'] | null {
  if (raw === undefined) return null
  if (!isAudienceKind(raw)) {
    throw createError({ statusCode: 400, message: 'Invalid audience' })
  }
  return raw
}

function parseLanguage(raw: unknown): string | null {
  if (raw === undefined) return null
  if (typeof raw !== 'string') {
    throw createError({ statusCode: 400, message: 'Language must be a string' })
  }
  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    throw createError({ statusCode: 400, message: 'Language cannot be empty' })
  }
  if (trimmed.length > LANGUAGE_MAX_LENGTH) {
    throw createError({ statusCode: 400, message: `Language too long (max ${LANGUAGE_MAX_LENGTH})` })
  }
  return trimmed
}

function extractIp(event: Parameters<Parameters<typeof defineEventHandler>[0]>[0]): string | null {
  return getRequestHeader(event, 'x-forwarded-for')?.split(',')[0]?.trim()
    || getRequestHeader(event, 'x-real-ip')
    || null
}
