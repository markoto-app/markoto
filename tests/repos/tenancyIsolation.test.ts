import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb, testDb } from '../integration/setup/db'
import { createDoc, createUser, createWorkspace, setMemberRole } from '../integration/setup/fixtures'
import { docAs, wsAs } from '../helpers/access'
import { createKnowledge, deleteKnowledgeRow, getKnowledge, getKnowledgeWithMarkdown } from '../../server/repos/knowledge'
import { deleteBrandAsset, getBrandAsset, getBrandAssetForDoc, insertBrandAsset } from '../../server/repos/brandAssets'
import { deleteWorkspaceInvite, upsertWorkspaceInvite } from '../../server/repos/workspaceInvites'
import { deleteWorkspaceTemplate, getWorkspaceTemplate, insertWorkspaceTemplate, updateWorkspaceTemplate } from '../../server/repos/workspaceTemplates'
import { removeMember, setRole } from '../../server/repos/workspaceMembers'
import { deleteShare, upsertShare } from '../../server/repos/documentShares'
import { listConfirmedUploadsForDoc, markConfirmed, recordPending } from '../../server/repos/uploads'
import { NotFoundError } from '../../server/repos/errors'

// Sub-resources (knowledge files, brand assets, invites, templates,
// members, shares, uploads) are addressed by their own id, but every repo
// function constrains the query to the parent named by the proof. A proof
// for workspace / document A must never reach B's rows, even when the
// caller passes B's sub-resource id — which is what an id taken from a
// URL or a model's tool call would be.

interface Tenant { adminId: number, workspaceId: string, docId: string }

async function tenant(): Promise<Tenant> {
  const admin = await createUser()
  const ws = await createWorkspace(admin.id)
  const doc = await createDoc({ ownerId: admin.id, workspaceId: ws.workspaceId })
  return { adminId: admin.id, workspaceId: ws.workspaceId, docId: doc.docId }
}

let a: Tenant
let b: Tenant

beforeEach(async () => {
  await resetDb()
  a = await tenant()
  b = await tenant()
})

describe('cross-workspace isolation of sub-resources', () => {
  it('knowledge: B\'s file is invisible and undeletable under A\'s proof', async () => {
    await createKnowledge(wsAs(b.workspaceId), {
      knowledgeId: 'kn-b', filename: 'b.pdf', sourceExt: 'pdf', mimeType: 'application/pdf',
      sizeBytes: 10, s3Key: 'workspaces/b/knowledge/kn-b.pdf', embeddingVersion: 'v', uploaderId: b.adminId
    })
    expect(await getKnowledge(wsAs(a.workspaceId), 'kn-b')).toBeNull()
    expect(await getKnowledgeWithMarkdown(wsAs(a.workspaceId), 'kn-b')).toBeNull()
    await deleteKnowledgeRow(wsAs(a.workspaceId), 'kn-b')
    expect(await getKnowledge(wsAs(b.workspaceId), 'kn-b')).not.toBeNull()
  })

  it('brand assets: neither A\'s workspace nor A\'s documents reach B\'s asset', async () => {
    expect(await insertBrandAsset(wsAs(b.workspaceId), {
      id: 'asset-b', kind: 'image', format: 'png', name: 'logo', weight: null, style: null,
      sizeBytes: 10, s3Key: 'workspaces/b/brand/asset-b.png', uploadedBy: b.adminId, licenceConfirmedAt: null
    }, 10)).toBe('inserted')
    expect(await getBrandAsset(wsAs(a.workspaceId), 'asset-b')).toBeNull()
    expect(await getBrandAssetForDoc(docAs(a.docId), 'asset-b')).toBeNull()
    expect(await deleteBrandAsset(wsAs(a.workspaceId), 'asset-b')).toBeNull()
    expect(await getBrandAssetForDoc(docAs(b.docId), 'asset-b')).not.toBeNull()
  })

  it('invites: A\'s admin cannot revoke B\'s invite', async () => {
    const inviteId = await upsertWorkspaceInvite(wsAs(b.workspaceId, b.adminId), {
      email: 'x@test.local', role: 'editor', tokenHash: null, expiresAt: new Date(Date.now() + 86_400_000)
    })
    expect(await deleteWorkspaceInvite(wsAs(a.workspaceId, a.adminId), inviteId)).toBeNull()
    const left = await testDb().query('SELECT 1 FROM workspace_invites WHERE invite_id = $1', [inviteId])
    expect(left.rowCount).toBe(1)
  })

  it('templates: A cannot read, rename or delete B\'s template, nor list B\'s document as its own', async () => {
    await insertWorkspaceTemplate(wsAs(b.workspaceId), docAs(b.docId), { id: 'tpl-b', name: 'B', description: '', createdBy: b.adminId })
    expect(await getWorkspaceTemplate(wsAs(a.workspaceId), 'tpl-b')).toBeNull()
    expect(await updateWorkspaceTemplate(wsAs(a.workspaceId), 'tpl-b', { name: 'stolen' })).toBe(false)
    expect(await deleteWorkspaceTemplate(wsAs(a.workspaceId), 'tpl-b')).toBeNull()
    expect((await getWorkspaceTemplate(wsAs(b.workspaceId), 'tpl-b'))?.name).toBe('B')
  })

  it('members: A\'s admin cannot change or remove a member of B only', async () => {
    const bob = await createUser()
    await setMemberRole(b.workspaceId, bob.id, 'editor')
    await expect(setRole(wsAs(a.workspaceId), bob.id, 'viewer')).rejects.toBeInstanceOf(NotFoundError)
    await expect(removeMember(wsAs(a.workspaceId), bob.id)).rejects.toBeInstanceOf(NotFoundError)
    const row = await testDb().query<{ role: string }>('SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [b.workspaceId, bob.id])
    expect(row.rows[0]?.role).toBe('editor')
  })
})

describe('cross-document isolation of sub-resources', () => {
  it('shares: removing a share under A\'s document leaves B\'s share alone', async () => {
    const guest = await createUser()
    await testDb().query('INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, \'guest\')', [b.workspaceId, guest.id])
    expect(await upsertShare(docAs(b.docId, b.adminId), { userId: guest.id, access: 'view' })).toBeNull() // new share
    expect(await deleteShare(docAs(a.docId), guest.id)).toBe(false)
    const left = await testDb().query('SELECT 1 FROM document_shares WHERE doc_id = $1 AND user_id = $2', [b.docId, guest.id])
    expect(left.rowCount).toBe(1)
  })

  it('uploads: confirming B\'s key under A\'s proof does nothing, and A\'s listing never shows it', async () => {
    const key = `docs/${b.docId}/img.png`
    await recordPending(docAs(b.docId), { fileId: 'img.png', uploaderId: b.adminId, contentType: 'image/png', sizeBytes: 1, s3Key: key })
    await markConfirmed(docAs(a.docId), key)
    expect(await listConfirmedUploadsForDoc(docAs(b.docId))).toHaveLength(0)
    await markConfirmed(docAs(b.docId), key)
    expect(await listConfirmedUploadsForDoc(docAs(b.docId))).toHaveLength(1)
    expect(await listConfirmedUploadsForDoc(docAs(a.docId))).toHaveLength(0)
  })
})
