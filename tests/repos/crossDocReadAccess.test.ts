import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb } from '../integration/setup/db'
import { createUser, createWorkspace, createDoc, setMemberRole } from '../integration/setup/fixtures'
import { decideTokenAccess, docStateOf } from '~~/shared/utils/docPermissions'
import { getDocWithActorRole } from '../../server/repos/documents'

// Cross-document access matrix for `view_other_document`. The handler
// delegates the policy decision to `getDocWithActorRole` +
// `decideTokenAccess`, the EXACT same shape `/api/docs/:id/token`
// uses. This file pins the answer for every (doc accessMode, actor
// scope) combination so a regression there can't silently widen the
// AI's reach beyond what a human session would see.
//
// We don't drive the whole tool through Hocuspocus here — the open
// connection requires a live sync-server. We DO exercise the same
// access decision the tool uses, using the same composition (DB row
// resolved → policy applied), so an over-permissive code path here
// would also leak through the tool.

async function checkAccess(docId: string, actorUserId: number) {
  const ctx = await getDocWithActorRole(docId, actorUserId)
  if (!ctx) return { reachable: false, reason: 'not_found' as const }
  const decision = decideTokenAccess(
    docStateOf(ctx),
    {
      userId: actorUserId,
      workspaceRole: ctx.workspaceRole
    }
  )
  return { reachable: decision.outcome === 'allow', outcome: decision.outcome, ctx }
}

describe('cross-doc read access — owner', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('owner can always read their private doc', async () => {
    const user = await createUser()
    const doc = await createDoc({ ownerId: user.id, accessMode: 'private' })
    const r = await checkAccess(doc.docId, user.id)
    expect(r.reachable).toBe(true)
  })

  it('owner can read their open-edit doc', async () => {
    const user = await createUser()
    const doc = await createDoc({ ownerId: user.id, accessMode: 'open-edit' })
    expect((await checkAccess(doc.docId, user.id)).reachable).toBe(true)
  })

  it('owner can read their password-protected doc', async () => {
    const user = await createUser()
    const doc = await createDoc({ ownerId: user.id, accessMode: 'password-protected', passwordHash: 'x' })
    expect((await checkAccess(doc.docId, user.id)).reachable).toBe(true)
  })
})

describe('cross-doc read access — non-owner, non-member', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('stranger CANNOT read someone\'s private doc (forbidden)', async () => {
    const owner = await createUser()
    const stranger = await createUser()
    const doc = await createDoc({ ownerId: owner.id, accessMode: 'private' })
    const r = await checkAccess(doc.docId, stranger.id)
    expect(r.reachable).toBe(false)
    // Anti-enumeration shape: outcome is "forbidden" not "ok with
    // password" so the AI tool turns it into a 404-shape message.
    expect(r.outcome).toBe('forbidden')
  })

  it('stranger CAN read an open-edit anonymous doc', async () => {
    const owner = await createUser()
    const stranger = await createUser()
    const doc = await createDoc({ ownerId: owner.id, accessMode: 'open-edit' })
    expect((await checkAccess(doc.docId, stranger.id)).reachable).toBe(true)
  })

  it('stranger CAN read an open-view doc (read-only access is enough)', async () => {
    const owner = await createUser()
    const stranger = await createUser()
    const doc = await createDoc({ ownerId: owner.id, accessMode: 'open-view' })
    const r = await checkAccess(doc.docId, stranger.id)
    expect(r.reachable).toBe(true)
  })

  it('stranger CANNOT read a password-protected doc — gets password-required', async () => {
    const owner = await createUser()
    const stranger = await createUser()
    const doc = await createDoc({ ownerId: owner.id, accessMode: 'password-protected', passwordHash: 'x' })
    const r = await checkAccess(doc.docId, stranger.id)
    expect(r.reachable).toBe(false)
    expect(r.outcome).toBe('password-required')
  })
})

describe('cross-doc read access — workspace member', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('viewer CAN read a workspace doc (read-only access is enough)', async () => {
    const owner = await createUser()
    const viewer = await createUser()
    const ws = await createWorkspace(owner.id)
    await setMemberRole(ws.workspaceId, owner.id, 'admin')
    await setMemberRole(ws.workspaceId, viewer.id, 'viewer')
    const doc = await createDoc({
      ownerId: owner.id,
      workspaceId: ws.workspaceId,
      accessMode: 'private'
    })
    expect((await checkAccess(doc.docId, viewer.id)).reachable).toBe(true)
  })

  it('editor CAN read a workspace doc', async () => {
    const owner = await createUser()
    const editor = await createUser()
    const ws = await createWorkspace(owner.id)
    await setMemberRole(ws.workspaceId, owner.id, 'admin')
    await setMemberRole(ws.workspaceId, editor.id, 'editor')
    const doc = await createDoc({
      ownerId: owner.id,
      workspaceId: ws.workspaceId,
      accessMode: 'private'
    })
    expect((await checkAccess(doc.docId, editor.id)).reachable).toBe(true)
  })

  it('admin CAN read a workspace doc', async () => {
    const owner = await createUser()
    const admin = await createUser()
    const ws = await createWorkspace(owner.id)
    await setMemberRole(ws.workspaceId, owner.id, 'admin')
    await setMemberRole(ws.workspaceId, admin.id, 'admin')
    const doc = await createDoc({
      ownerId: owner.id,
      workspaceId: ws.workspaceId,
      accessMode: 'private'
    })
    expect((await checkAccess(doc.docId, admin.id)).reachable).toBe(true)
  })

  it('member of WORKSPACE A cannot read a private doc in WORKSPACE B', async () => {
    // Membership in workspace A doesn't bleed into workspace B.
    const a = await createUser()
    const b = await createUser()
    const wsA = await createWorkspace(a.id)
    const wsB = await createWorkspace(b.id)
    await setMemberRole(wsA.workspaceId, a.id, 'admin')
    await setMemberRole(wsB.workspaceId, b.id, 'admin')
    const docInB = await createDoc({
      ownerId: b.id,
      workspaceId: wsB.workspaceId,
      accessMode: 'private'
    })
    expect((await checkAccess(docInB.docId, a.id)).reachable).toBe(false)
  })

  it('workspace membership BYPASSES the password gate', async () => {
    // Documented behaviour: a password-protected doc inside a workspace
    // is reachable to its members without typing the password. Same
    // semantics the editor URL has.
    const owner = await createUser()
    const member = await createUser()
    const ws = await createWorkspace(owner.id)
    await setMemberRole(ws.workspaceId, owner.id, 'admin')
    await setMemberRole(ws.workspaceId, member.id, 'editor')
    const doc = await createDoc({
      ownerId: owner.id,
      workspaceId: ws.workspaceId,
      accessMode: 'password-protected',
      passwordHash: 'x'
    })
    const r = await checkAccess(doc.docId, member.id)
    expect(r.reachable).toBe(true)
  })
})

describe('cross-doc read access — non-existent doc', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('returns not_found for a non-existent id', async () => {
    const user = await createUser()
    const r = await checkAccess('does-not-exist', user.id)
    expect(r.reachable).toBe(false)
    expect((r as { reason: string }).reason).toBe('not_found')
  })
})
