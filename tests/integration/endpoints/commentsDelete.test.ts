import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb } from '../setup/db'
import { anonClient, loggedInClient } from '../setup/client'
import {
  createDoc,
  createUser,
  createWorkspace,
  setMemberRole
} from '../setup/fixtures'

// Auth gates on the comment-delete endpoints. The endpoints route
// through a trusted Hocuspocus client to mutate the live Y.Doc — that
// part needs a real sync server, which the integration stack doesn't
// run (the stack uses an HTTP stub on port 4010). What we CAN cover
// here is the gate ordering BEFORE the trusted client opens:
//
//   1. Auth middleware: anonymous → 401
//   2. requireValidatedUserSession: invalid session → 401
//   3. getDocAuthz.exists check: missing doc → 404
//   4. getDocAuthz.canEdit check: viewer / non-member → 403
//
// The "author can delete own comment" path requires a live trusted
// client; covered manually + via the e2e flow that runs against the
// full ephemeral stack.

const FAKE_COMMENT_ID = 'cmnt-not-needed-for-gate'
const FAKE_REPLY_ID = 'rply-not-needed-for-gate'

describe('DELETE /api/docs/:docId/comments/:commentId — auth gates', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('rejects anonymous (401)', async () => {
    const owner = await createUser()
    const doc = await createDoc({ ownerId: owner.id })
    const res = await anonClient().delete(
      `/api/docs/${doc.docId}/comments/${FAKE_COMMENT_ID}`
    )
    expect(res.status).toBe(401)
  })

  it('returns 404 when the doc does not exist', async () => {
    const u = await createUser()
    const c = await loggedInClient(u.id)
    const res = await c.delete(`/api/docs/does-not-exist/comments/${FAKE_COMMENT_ID}`)
    expect(res.status).toBe(404)
  })

  it('rejects a logged-in non-owner of a standalone doc (403, no edit access)', async () => {
    // Standalone doc with an owner. A non-owner has neither owner
    // rights nor workspace-membership rights → canEdit=false → 403.
    const owner = await createUser()
    const other = await createUser()
    const doc = await createDoc({ ownerId: owner.id, accessMode: 'open-edit' })
    const c = await loggedInClient(other.id)
    const res = await c.delete(`/api/docs/${doc.docId}/comments/${FAKE_COMMENT_ID}`)
    expect(res.status).toBe(403)
  })

  it('rejects a workspace viewer (403)', async () => {
    // Viewer can browse comments in the panel but can't author or
    // delete. Same posture as theme/title — read-only across the
    // board.
    const admin = await createUser()
    const viewer = await createUser()
    const ws = await createWorkspace(admin.id)
    await setMemberRole(ws.workspaceId, viewer.id, 'viewer')
    const doc = await createDoc({ ownerId: admin.id, workspaceId: ws.workspaceId })
    const c = await loggedInClient(viewer.id)
    const res = await c.delete(`/api/docs/${doc.docId}/comments/${FAKE_COMMENT_ID}`)
    expect(res.status).toBe(403)
  })

  it('rejects a workspace outsider on a workspace doc (403)', async () => {
    const admin = await createUser()
    const outsider = await createUser()
    const ws = await createWorkspace(admin.id)
    const doc = await createDoc({ ownerId: admin.id, workspaceId: ws.workspaceId })
    const c = await loggedInClient(outsider.id)
    const res = await c.delete(`/api/docs/${doc.docId}/comments/${FAKE_COMMENT_ID}`)
    expect(res.status).toBe(403)
  })

  it('rejects a malformed commentId with 400', async () => {
    // Empty / oversized commentId should fail input validation BEFORE
    // hitting authz — protects the trusted-client path from junk.
    const owner = await createUser()
    const doc = await createDoc({ ownerId: owner.id })
    const c = await loggedInClient(owner.id)
    const oversized = 'a'.repeat(200)
    const res = await c.delete(`/api/docs/${doc.docId}/comments/${oversized}`)
    expect(res.status).toBe(400)
  })
})

describe('DELETE /api/docs/:docId/comments/:commentId/replies/:replyId — auth gates', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('rejects anonymous (401)', async () => {
    const owner = await createUser()
    const doc = await createDoc({ ownerId: owner.id })
    const res = await anonClient().delete(
      `/api/docs/${doc.docId}/comments/${FAKE_COMMENT_ID}/replies/${FAKE_REPLY_ID}`
    )
    expect(res.status).toBe(401)
  })

  it('returns 404 when the doc does not exist', async () => {
    const u = await createUser()
    const c = await loggedInClient(u.id)
    const res = await c.delete(`/api/docs/does-not-exist/comments/${FAKE_COMMENT_ID}/replies/${FAKE_REPLY_ID}`)
    expect(res.status).toBe(404)
  })

  it('rejects a workspace viewer (403)', async () => {
    const admin = await createUser()
    const viewer = await createUser()
    const ws = await createWorkspace(admin.id)
    await setMemberRole(ws.workspaceId, viewer.id, 'viewer')
    const doc = await createDoc({ ownerId: admin.id, workspaceId: ws.workspaceId })
    const c = await loggedInClient(viewer.id)
    const res = await c.delete(`/api/docs/${doc.docId}/comments/${FAKE_COMMENT_ID}/replies/${FAKE_REPLY_ID}`)
    expect(res.status).toBe(403)
  })

  it('rejects a malformed replyId with 400', async () => {
    const owner = await createUser()
    const doc = await createDoc({ ownerId: owner.id })
    const c = await loggedInClient(owner.id)
    const oversized = 'r'.repeat(200)
    const res = await c.delete(`/api/docs/${doc.docId}/comments/${FAKE_COMMENT_ID}/replies/${oversized}`)
    expect(res.status).toBe(400)
  })
})
