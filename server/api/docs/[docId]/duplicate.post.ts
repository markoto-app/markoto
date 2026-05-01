import { nanoid } from 'nanoid'
import { getDoc } from '../../../repos/documents'
import { duplicateDocument } from '../../../utils/duplicateDocument'
import { withIdempotency } from '../../../utils/idempotency'

// Duplicate a document into a new docId. The duplicator becomes the
// new owner — duplicates are "my copy of their template". Same
// workspace by default (pass `workspaceId: null` to park it as a
// personal doc, or a string to re-target).
//
// Inherits: title (as "Copy of …" unless overridden), theme,
// accessMode, password, word/size counters, Y.js state (with image URL
// rewrite so `/api/files/{docId}/…` paths target the new doc), and all
// S3 image assets (CopyObject'd into the new prefix).
//
// Permissions inheritance comes for free: placing the new doc in a
// workspace means its members — including editors and viewers — get
// the same grants they had on the source. No explicit ACL copy needed.
//
// Authz:
//   - canEditDoc on the source. Anyone who could edit the source's
//     content can create a copy of it; that's weaker than "manage",
//     but stealing edit access is not a thing — the duplicate goes
//     into the actor's ownership, not the source owner's.
//   - If a different workspace is targeted, actor must be admin or
//     editor there (same gate as /api/docs POST).
export default defineEventHandler(async (event) => {
  const session = await requireValidatedUserSession(event)
  const sourceDocId = requireDocId(event)
  // `readBody` returns undefined for an empty/missing body — the `.catch`
  // only covers parse errors, so a naked POST falls through without
  // entering the catch branch. Coerce to `{}` so the `in` / property
  // reads below don't trip on undefined.
  const body = ((await readBody(event).catch(() => null)) ?? {}) as {
    title?: unknown
    workspaceId?: unknown
  }

  const authz = await getDocAuthz(session.user.id, sourceDocId)
  if (!authz.exists) {
    throw createError({ statusCode: 404, message: 'Document not found' })
  }
  if (!authz.canEdit) {
    throw createError({ statusCode: 403, message: 'Not authorized to duplicate this document' })
  }

  const source = await getDoc(sourceDocId)
  if (!source) {
    // Shouldn't happen after authz.exists, but guards against a TOCTOU delete.
    throw createError({ statusCode: 404, message: 'Document not found' })
  }

  // Title: user-provided > "Copy of {source.title}" > "Copy of Untitled".
  let title: string
  if (typeof body.title === 'string' && body.title.trim().length > 0) {
    title = body.title.trim()
  } else {
    title = `Copy of ${source.title || 'Untitled'}`
  }
  if (title.length > 255) title = title.slice(0, 255)

  // Target workspace:
  //   undefined  → same as source (default)
  //   null       → remove from workspace (personal doc)
  //   string     → move into the given workspace
  let targetWorkspaceId: string | null
  if (!('workspaceId' in body)) {
    targetWorkspaceId = source.workspaceId
  } else if (body.workspaceId === null) {
    targetWorkspaceId = null
  } else if (typeof body.workspaceId === 'string' && body.workspaceId.length > 0) {
    targetWorkspaceId = body.workspaceId
  } else {
    throw createError({ statusCode: 400, message: 'workspaceId must be a string, null, or omitted' })
  }

  // Membership check when targeting a workspace different from source's.
  // (Same-workspace is implied — the actor already passed canEditDoc
  // which covers membership there.)
  if (targetWorkspaceId !== null && targetWorkspaceId !== source.workspaceId) {
    const targetRole = await getWorkspaceRole(session.user.id, targetWorkspaceId)
    if (targetRole === null) {
      throw createError({ statusCode: 403, message: 'Not a member of the target workspace' })
    }
    if (targetRole === 'viewer') {
      throw createError({ statusCode: 403, message: 'Viewers cannot create documents in a workspace' })
    }
  }

  // Idempotency: when the client supplies an `Idempotency-Key` header,
  // a rapid second call (double-click, retry on flaky network) returns
  // the SAME { docId } without creating a second copy. Without the
  // header, behaviour is unchanged. Scope is per-user so a key reused
  // across users does not collide; the `duplicate:{sourceDocId}` scope
  // segment also keeps a key from short-circuiting a different doc's
  // duplicate. See `server/utils/idempotency.ts` for the contract.
  const config = useRuntimeConfig()
  return withIdempotency(event, `duplicate:${sourceDocId}`, session.user.id, async () => {
    const newDocId = nanoid(10)
    await duplicateDocument(
      {
        sourceDocId,
        newDocId,
        ownerId: session.user.id,
        workspaceId: targetWorkspaceId,
        title
      },
      { s3: useS3Client(), bucket: config.s3.bucket }
    )

    return { docId: newDocId }
  })
})
