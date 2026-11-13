import { beforeEach, describe, expect, it } from 'vitest'
import { resetDb, testDb } from '../setup/db'
import { anonClient, loggedInClient } from '../setup/client'
import { createDoc, createUser, createWorkspace, setMemberRole } from '../setup/fixtures'
import { TEST_BILLING_OFF_BASE_URL } from '../setup/env'

// Share-link controls: link expiry, view-only without download,
// view counts: set by the owner / workspace admins, enforced on every
// access path, refused to set without the plan feature.

const inAnHour = () => new Date(Date.now() + 3_600_000).toISOString()

async function expire(docId: string): Promise<void> {
  await testDb().query(`UPDATE documents SET share_expires_at = now() - interval '1 minute' WHERE doc_id = $1`, [docId])
}

describe('share-link controls', () => {
  beforeEach(async () => {
    await resetDb()
  })

  it('owner sets an expiry; once it passes, visitors are refused everywhere and told why', async () => {
    const owner = await createUser()
    const doc = await createDoc({ ownerId: owner.id, accessMode: 'open-view' })
    const ownerClient = await loggedInClient(owner.id)
    const put = await ownerClient.put(`/api/docs/${doc.docId}/share-settings`, { expiresAt: inAnHour() })
    expect(put.status).toBe(200)
    expect((await anonClient().get(`/api/docs/${doc.docId}/token`)).status).toBe(200)
    expect((await (await anonClient().get(`/api/docs/${doc.docId}/token`)).json() as { token: string | null }).token).toBeTruthy()

    await expire(doc.docId)
    const denied = await (await anonClient().get(`/api/docs/${doc.docId}/token`)).json() as { token: string | null, forbidden: boolean, shareExpired: boolean, ownerId: unknown }
    expect(denied).toMatchObject({ token: null, forbidden: true, shareExpired: true, ownerId: null })
    expect((await anonClient().get(`/api/docs/${doc.docId}/pdf`)).status).toBe(403)
    expect((await anonClient().get(`/api/docs/${doc.docId}/activity`)).status).toBe(403)
    const meta = await (await anonClient().get(`/api/docs/${doc.docId}/meta`)).json() as Record<string, unknown>
    expect(meta.forbidden).toBe(true)
    expect(meta.title).toBeUndefined()
    // The owner keeps access.
    const own = await (await ownerClient.get(`/api/docs/${doc.docId}/token`)).json() as { token: string | null }
    expect(own.token).toBeTruthy()
  })

  it('expiry checks: in the future, at most a year, owner / admins only', async () => {
    const owner = await createUser()
    const ws = await createWorkspace(owner.id)
    const editor = await createUser()
    await setMemberRole(ws.workspaceId, editor.id, 'editor')
    const admin = await createUser()
    await setMemberRole(ws.workspaceId, admin.id, 'admin')
    const doc = await createDoc({ ownerId: owner.id, workspaceId: ws.workspaceId, accessMode: 'open-view' })
    const path = `/api/docs/${doc.docId}/share-settings`
    const ownerClient = await loggedInClient(owner.id)
    expect((await ownerClient.put(path, { expiresAt: new Date(Date.now() - 1000).toISOString() })).status).toBe(400)
    expect((await ownerClient.put(path, { expiresAt: new Date(Date.now() + 400 * 86_400_000).toISOString() })).status).toBe(400)
    expect((await ownerClient.put(path, { expiresAt: 'tomorrow' })).status).toBe(400)
    expect((await (await loggedInClient(editor.id)).put(path, { noDownload: true })).status).toBe(403)
    expect((await (await loggedInClient(admin.id)).put(path, { noDownload: true })).status).toBe(200)
    const audit = await testDb().query(`SELECT after, workspace_id FROM audit_log WHERE action = 'doc.share_settings_changed'`)
    expect(audit.rows).toEqual([{ after: { expiresAt: null, noDownload: true }, workspace_id: ws.workspaceId }])
  })

  it('view-only: visitors get no PDF, the owner and members do; the token says so', async () => {
    const owner = await createUser()
    const ws = await createWorkspace(owner.id)
    const viewer = await createUser()
    await setMemberRole(ws.workspaceId, viewer.id, 'viewer')
    const doc = await createDoc({ ownerId: owner.id, workspaceId: ws.workspaceId, accessMode: 'open-view' })
    const ownerClient = await loggedInClient(owner.id)
    expect((await ownerClient.put(`/api/docs/${doc.docId}/share-settings`, { noDownload: true })).status).toBe(200)

    const visitorToken = await (await anonClient().get(`/api/docs/${doc.docId}/token`)).json() as { noDownload: boolean, token: string | null }
    expect(visitorToken).toMatchObject({ noDownload: true })
    expect(visitorToken.token).toBeTruthy()
    const pdf = await anonClient().get(`/api/docs/${doc.docId}/pdf`)
    expect(pdf.status).toBe(403)
    expect((await pdf.json() as { data: { code: string } }).data.code).toBe('share/download-disabled')
    expect((await (await ownerClient.get(`/api/docs/${doc.docId}/token`)).json() as { noDownload: boolean }).noDownload).toBe(false)
    expect((await (await (await loggedInClient(viewer.id)).get(`/api/docs/${doc.docId}/token`)).json() as { noDownload: boolean }).noDownload).toBe(false)
  })

  it('counts opens by visitors, not by the owner, and shows them to the owner', async () => {
    const owner = await createUser()
    const doc = await createDoc({ ownerId: owner.id, accessMode: 'open-view' })
    for (let i = 0; i < 3; i++) await anonClient().get(`/api/docs/${doc.docId}/token`)
    await (await loggedInClient((await createUser()).id)).get(`/api/docs/${doc.docId}/token`)
    const ownerClient = await loggedInClient(owner.id)
    await ownerClient.get(`/api/docs/${doc.docId}/token`)
    // Recorded fire-and-forget: give it a moment.
    await expect.poll(async () => (await (await ownerClient.get(`/api/docs/${doc.docId}/share-settings`)).json() as { views: { total: number } }).views.total, { timeout: 5000 }).toBe(4)
    const settings = await (await ownerClient.get(`/api/docs/${doc.docId}/share-settings`)).json() as { views: { byDay: Array<{ day: string, opens: number }>, lastDay: string } }
    expect(settings.views.byDay).toHaveLength(1)
    expect(settings.views.lastDay).toBe(new Date().toISOString().slice(0, 10))
    // Visitors don't see the settings.
    expect((await anonClient().get(`/api/docs/${doc.docId}/share-settings`)).status).toBe(401)
  })

  it('markoto.app free: can\'t set restrictions or see counts, but can clear existing ones', async () => {
    const owner = await createUser()
    const doc = await createDoc({ ownerId: owner.id, accessMode: 'open-view' })
    const hosted = await loggedInClient(owner.id, undefined, TEST_BILLING_OFF_BASE_URL)
    const refused = await hosted.put(`/api/docs/${doc.docId}/share-settings`, { noDownload: true })
    expect(refused.status).toBe(409)
    expect((await refused.json() as { data: { code: string } }).data.code).toBe('plan/feature-unavailable')
    const settings = await (await hosted.get(`/api/docs/${doc.docId}/share-settings`)).json() as { available: boolean, views: unknown }
    expect(settings).toMatchObject({ available: false, views: null })
    // Set before a downgrade (seeded): still in force, and clearable.
    await testDb().query('UPDATE documents SET share_no_download = true WHERE doc_id = $1', [doc.docId])
    expect((await (await anonClient(TEST_BILLING_OFF_BASE_URL).get(`/api/docs/${doc.docId}/token`)).json() as { noDownload: boolean }).noDownload).toBe(true)
    expect((await hosted.put(`/api/docs/${doc.docId}/share-settings`, { noDownload: false })).status).toBe(200)
  })

  it('an expired password link: the password no longer unlocks it, and an earlier unlock stops opening files', async () => {
    const owner = await createUser()
    const doc = await createDoc({ ownerId: owner.id, accessMode: 'open-edit' })
    const ownerClient = await loggedInClient(owner.id)
    expect((await ownerClient.post(`/api/docs/${doc.docId}/password`, { action: 'set', password: 'correct horse' })).status).toBe(200)
    const expiresAt = new Date(Date.now() + 30 * 60_000)
    expect((await ownerClient.put(`/api/docs/${doc.docId}/share-settings`, { expiresAt: expiresAt.toISOString() })).status).toBe(200)

    const unlocked = await anonClient().post(`/api/docs/${doc.docId}/password`, { action: 'verify', password: 'correct horse' })
    expect(unlocked.status).toBe(200)
    const { token } = await unlocked.json() as { token: string }
    // The token never outlives the link (30 min here, not 2 h).
    const exp = (JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()) as { exp: number }).exp
    expect(exp).toBeLessThanOrEqual(Math.ceil(expiresAt.getTime() / 1000))
    const bearer = { headers: { authorization: `Bearer ${token}` } }
    expect((await anonClient().get(`/api/docs/${doc.docId}/activity`, bearer)).status).toBe(200)

    await expire(doc.docId)
    const again = await anonClient().post(`/api/docs/${doc.docId}/password`, { action: 'verify', password: 'correct horse' })
    expect(again.status).toBe(403)
    expect((await again.json() as { data: { code: string } }).data.code).toBe('share/expired')
    // The token from before the expiry no longer opens anything.
    expect((await anonClient().get(`/api/docs/${doc.docId}/activity`, bearer)).status).toBe(403)
    const meta = await (await anonClient().get(`/api/docs/${doc.docId}/meta`, bearer)).json() as Record<string, unknown>
    expect(meta).toMatchObject({ forbidden: true, accessMode: 'private', hasPassword: false })
  })

  it('view-only: a guest can\'t take a copy (REST duplicate or the AI tool)', async () => {
    const admin = await createUser()
    const ws = await createWorkspace(admin.id)
    const guest = await createUser()
    await setMemberRole(ws.workspaceId, guest.id, 'guest')
    const doc = await createDoc({ ownerId: admin.id, workspaceId: ws.workspaceId, accessMode: 'private' })
    const adminClient = await loggedInClient(admin.id)
    expect((await adminClient.put(`/api/docs/${doc.docId}/shares`, { userId: guest.id, access: 'edit' })).status).toBe(200)
    expect((await adminClient.put(`/api/docs/${doc.docId}/share-settings`, { noDownload: true })).status).toBe(200)

    const guestClient = await loggedInClient(guest.id)
    const dup = await guestClient.post(`/api/docs/${doc.docId}/duplicate`, { workspaceId: null })
    expect(dup.status).toBe(403)
    expect((await dup.json() as { data: { code: string } }).data.code).toBe('share/download-disabled')
    const tool = await guestClient.post('/api/_test/exec-ai-tool', { docId: doc.docId, name: 'duplicate_document', args: { source_doc_id: doc.docId, workspace_id: '' } })
    const toolBody = await tool.json() as { isError: boolean, content: string }
    expect(toolBody.isError).toBe(true)
    expect(toolBody.content).toMatch(/turned off downloading/)
    const md = await guestClient.post('/api/_test/exec-ai-tool', { docId: doc.docId, name: 'export_document_as_markdown', args: {} })
    expect((await md.json() as { isError: boolean }).isError).toBe(true)
    // The workspace admin still can.
    expect((await adminClient.post(`/api/docs/${doc.docId}/duplicate`, {})).status).toBeLessThan(300)
  })

  it('a token refresh is not counted as another open', async () => {
    const owner = await createUser()
    const doc = await createDoc({ ownerId: owner.id, accessMode: 'open-view' })
    await anonClient().get(`/api/docs/${doc.docId}/token`)
    await anonClient().get(`/api/docs/${doc.docId}/token?refresh=1`)
    await anonClient().get(`/api/docs/${doc.docId}/token?refresh=1`)
    const ownerClient = await loggedInClient(owner.id)
    await expect.poll(async () => (await (await ownerClient.get(`/api/docs/${doc.docId}/share-settings`)).json() as { views: { total: number } }).views.total, { timeout: 5000 }).toBe(1)
    // Give a late (wrongly counted) refresh time to land, then re-check.
    await new Promise(r => setTimeout(r, 500))
    expect((await (await ownerClient.get(`/api/docs/${doc.docId}/share-settings`)).json() as { views: { total: number } }).views.total).toBe(1)
  })
})
