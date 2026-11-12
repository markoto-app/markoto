import { nanoid } from 'nanoid'
import { getMembershipRole, proveWorkspaceAccess } from '../../../utils/access/workspaceAccess'
import type { WorkspaceAccess } from '../../../repos/proofs'
import { duplicateDocument, ImageQuotaExceededError } from '../../../utils/documents/duplicateDocument'
import { withIdempotency } from '../../../utils/platform/idempotency'
import { imageQuotaError, resolveImageQuota } from '../../../utils/storage/imageQuota'
import { flushSyncDocument } from '../../../utils/documents/syncNotify'
import { canDownload } from '~~/shared/utils/documents/docPermissions'
import { duplicateDocBody } from '~~/shared/api/sharing'
import { useEnv } from '~~/shared/env/load'

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
//   - `edit` on the source. Anyone who could edit the source's
//     content can create a copy of it; that's weaker than "manage",
//     but stealing edit access is not a thing — the duplicate goes
//     into the actor's ownership, not the source owner's.
//   - View only: a copy is a download — a visitor (guests included)
//     of a view-only document can't take one.
//   - Any target workspace (the source's own included) needs admin or
//     editor membership there (same gate as /api/docs POST) — guests
//     are refused with 403 `workspace/guest-cannot-create`.
export default defineApiHandler({
  access: allow.doc('edit'),
  body: duplicateDocBody,
  handler: async ({ event, user, self, docId: sourceDocId, docAccess, doc: source, state, actor, body }) => {
    if (!canDownload(state, actor, source.shareNoDownload)) throw apiError('share/download-disabled')

    const title = resolveTitle(body?.title, source.title)
    // Left out: the source's workspace; null: a personal copy.
    const targetWorkspaceId = body?.workspaceId === undefined ? source.workspaceId : body.workspaceId
    const target = await assertCanCreateInTarget(user.id, targetWorkspaceId)

    // Idempotency: when the client supplies an `Idempotency-Key` header,
    // a rapid second call (double-click, retry on flaky network) returns
    // the SAME { docId } without creating a second copy. Without the
    // header, behaviour is unchanged. Scope is per-user so a key reused
    // across users does not collide; the `duplicate:{sourceDocId}` scope
    // segment also keeps a key from short-circuiting a different doc's
    // duplicate (why this isn't the wrapper's static `idempotency` option).
    // See `server/utils/platform/idempotency.ts` for the contract.
    const env = useEnv()
    return withIdempotency(event, `duplicate:${sourceDocId}`, user.id, async () => {
      const newDocId = nanoid(10)
      // The copied images count against the target Team / Business
      // workspace's pool, else the duplicator's personal quota.
      const imageQuota = await resolveImageQuota(user.id, null, targetWorkspaceId)
      // The clone reads the persisted Y.js rows; edits from the last
      // couple of seconds may still sit in the sync-server's debounced
      // store. Persist them first so the copy matches what the user sees.
      await flushSyncDocument(sourceDocId)
      try {
        await duplicateDocument(
          { source: docAccess, newDocId, owner: self, workspace: target, title },
          { s3: useS3Client(), bucket: env.storage.bucket, imageQuota }
        )
      } catch (e) {
        if (e instanceof ImageQuotaExceededError) throw imageQuotaError(e.limitBytes)
        throw e
      }
      return { docId: newDocId }
    })
  }
})

/** Title: user-provided > "Copy of {source.title}" > "Copy of Untitled". Caps at 255 chars. */
function resolveTitle(rawTitle: string | undefined, sourceTitle: string | null | undefined): string {
  let title: string
  if (rawTitle !== undefined && rawTitle.trim().length > 0) {
    title = rawTitle.trim()
  } else {
    title = `Copy of ${sourceTitle || 'Untitled'}`
  }
  return title.length > 255 ? title.slice(0, 255) : title
}

/**
 * Creation-grade membership in the target workspace (admin / editor),
 * the same gate as `/api/docs` POST and the AI / MCP `duplicate_document`
 * tool. Checked for the source's own workspace too: edit rights on the
 * source don't imply membership — a guest edits a shared document
 * through its share only and must never create documents in the
 * workspace (the copy would be theirs to manage, move out and keep after
 * their removal). Guests get a dedicated code; a personal copy is not
 * offered (the editor's Duplicate always keeps the source's workspace).
 */
async function assertCanCreateInTarget(userId: number, targetWorkspaceId: string | null): Promise<WorkspaceAccess<'editor'> | null> {
  if (targetWorkspaceId === null) return null
  const member = await proveWorkspaceAccess(userId, targetWorkspaceId, 'member')
  if (member?.allows('editor')) return member
  const targetRole = member ? 'viewer' : null
  if (targetRole === null && (await getMembershipRole(targetWorkspaceId, userId)) === 'guest') {
    throw apiError('workspace/guest-cannot-create')
  }
  if (targetRole === null) throw apiError('auth/forbidden')
  throw apiError('workspace/role-required')
}
