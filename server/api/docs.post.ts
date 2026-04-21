import { nanoid } from 'nanoid'
import { createDoc } from '../repos/documents'

export default defineEventHandler(async (event) => {
  // `getValidatedUserSession` cross-checks the DB and clears stale cookies.
  // Anonymous creation is allowed — ownerId falls back to null.
  const session = await getValidatedUserSession(event)
  const docId = nanoid(10)
  const ownerId = session?.user?.id ?? null

  // Optional workspace assignment. Honoured for logged-in admins and editors
  // of the target workspace. Viewers cannot create docs (no write grant in
  // the workspace). Anonymous callers can never file into a workspace.
  // Set at creation only; moves between workspaces aren't supported yet.
  const body: { workspaceId?: unknown } = await readBody(event).catch(() => ({}))
  let workspaceId: string | null = null
  if (typeof body?.workspaceId === 'string' && body.workspaceId.length > 0) {
    if (ownerId == null) {
      throw createError({ statusCode: 401, message: 'Login required to use workspaces' })
    }
    const role = await getWorkspaceRole(ownerId, body.workspaceId)
    if (role === null) {
      throw createError({ statusCode: 403, message: 'Not a member of this workspace' })
    }
    if (role === 'viewer') {
      throw createError({ statusCode: 403, message: 'Viewers cannot create documents' })
    }
    workspaceId = body.workspaceId
  }

  // Default visibility:
  //   - Logged-in owner → `private`. The user has to explicitly publish via
  //     the Share modal before anyone else can access it.
  //   - Anonymous creator → `open-edit`. There's no stable identity to tie
  //     "private" to, so defaulting to private would lock the creator out.
  const accessMode = ownerId != null ? 'private' : 'open-edit'

  await createDoc({ docId, ownerId, workspaceId, accessMode })

  return { docId }
})
