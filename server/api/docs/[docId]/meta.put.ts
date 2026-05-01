import { getDoc, updateDocMeta, type MetaUpdate } from '../../../repos/documents'
import { appendAuditEvent } from '../../../repos/audit'
import { isAudienceKind } from '~~/shared/audiences'
import { LANGUAGE_MAX_LENGTH } from '~~/shared/languages'

const DESCRIPTION_MAX_LENGTH = 500

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

  const updates: MetaUpdate = {}

  if (body.title !== undefined) {
    if (typeof body.title !== 'string') throw createError({ statusCode: 400, message: 'Title must be a string' })
    if (body.title.length > 255) throw createError({ statusCode: 400, message: 'Title too long (max 255)' })
    updates.title = body.title.trim()
  }

  if (body.accessMode !== undefined) {
    const allowed = new Set(['private', 'open-edit', 'open-view', 'password-protected'])
    if (!allowed.has(body.accessMode)) throw createError({ statusCode: 400, message: 'Invalid access mode' })
    updates.accessMode = body.accessMode
  }

  if (typeof body.wordCount === 'number') {
    if (body.wordCount < 0 || body.wordCount > 10_000_000 || !Number.isFinite(body.wordCount)) {
      throw createError({ statusCode: 400, message: 'Invalid wordCount' })
    }
    updates.wordCount = Math.round(body.wordCount)
  }

  if (typeof body.sizeBytes === 'number') {
    if (body.sizeBytes < 0 || body.sizeBytes > 100_000_000 || !Number.isFinite(body.sizeBytes)) {
      throw createError({ statusCode: 400, message: 'Invalid sizeBytes' })
    }
    updates.sizeBytes = Math.round(body.sizeBytes)
  }

  if (body.theme !== undefined) {
    // null = reset to defaultTheme; otherwise must be a structurally valid DocTheme.
    if (body.theme !== null && !isValidTheme(body.theme)) {
      throw createError({ statusCode: 400, message: 'Invalid theme payload' })
    }
    updates.theme = body.theme
  }

  if (body.description !== undefined) {
    if (typeof body.description !== 'string') {
      throw createError({ statusCode: 400, message: 'Description must be a string' })
    }
    if (body.description.length > DESCRIPTION_MAX_LENGTH) {
      throw createError({ statusCode: 400, message: `Description too long (max ${DESCRIPTION_MAX_LENGTH})` })
    }
    updates.description = body.description.trim()
  }

  if (body.audience !== undefined) {
    if (!isAudienceKind(body.audience)) {
      throw createError({ statusCode: 400, message: 'Invalid audience' })
    }
    updates.audience = body.audience
  }

  if (body.language !== undefined) {
    if (typeof body.language !== 'string') {
      throw createError({ statusCode: 400, message: 'Language must be a string' })
    }
    const trimmed = body.language.trim()
    if (trimmed.length === 0) {
      throw createError({ statusCode: 400, message: 'Language cannot be empty' })
    }
    if (trimmed.length > LANGUAGE_MAX_LENGTH) {
      throw createError({ statusCode: 400, message: `Language too long (max ${LANGUAGE_MAX_LENGTH})` })
    }
    updates.language = trimmed
  }

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
    const ip = getRequestHeader(event, 'x-forwarded-for')?.split(',')[0]?.trim()
      || getRequestHeader(event, 'x-real-ip')
      || null
    await appendAuditEvent({
      actorUserId: session.user.id,
      actorIp: ip,
      scope: 'doc',
      scopeId: docId,
      action: 'doc.access_mode_changed',
      before: { accessMode: beforeAccessMode },
      after: { accessMode: updates.accessMode }
    })
  }

  return { success: true }
})
