import { updateDocMeta, type MetaUpdate } from '../../../repos/documents'

export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const docId = requireDocId(event)
  const body = await readBody(event)

  // Meta changes split by kind: access_mode is a sharing/ownership change
  // (owner + workspace admin only), everything else is an edit (owner +
  // admin + editor). Viewers cannot change anything.
  const authz = await getDocAuthz(session.user.id, docId)
  if (!authz.exists) {
    throw createError({ statusCode: 404, message: 'Document not found' })
  }
  if (!authz.canEdit) {
    throw createError({ statusCode: 403, message: 'Not authorized to edit this document' })
  }
  const accessModeInputEarly = body.accessMode ?? body.access_mode
  if (accessModeInputEarly !== undefined && !authz.canManage) {
    throw createError({ statusCode: 403, message: 'Only owners and admins can change access mode' })
  }

  const updates: MetaUpdate = {}

  if (body.title !== undefined) {
    if (typeof body.title !== 'string') throw createError({ statusCode: 400, message: 'Title must be a string' })
    if (body.title.length > 255) throw createError({ statusCode: 400, message: 'Title too long (max 255)' })
    updates.title = body.title.trim()
  }

  // Canonical field name is `accessMode` (camelCase). The older `access_mode`
  // spelling is accepted for one release cycle so any clients mid-upgrade
  // don't silently fail — remove after the next deploy window.
  const accessModeInput = body.accessMode ?? body.access_mode
  if (accessModeInput !== undefined) {
    const allowed = new Set(['private', 'open-edit', 'open-view', 'password-protected'])
    if (!allowed.has(accessModeInput)) throw createError({ statusCode: 400, message: 'Invalid access mode' })
    updates.accessMode = accessModeInput
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

  await updateDocMeta(docId, updates)
  return { success: true }
})
